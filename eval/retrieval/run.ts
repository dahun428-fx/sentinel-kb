/**
 * 러너 본체. 골든셋 × 검색함수 → `RetrievalReport`.
 *
 * **DB도 fetch도 env도 모른다.** 케이스 배열과 `SearchFn`만 받는다 — 그래야 단위 테스트가
 * 컨테이너 없이 러너의 집계·경고·판정을 전부 돌려 볼 수 있고, `run.cli.ts`는 컴포지션 루트로만
 * 남는다(`scripts/seed.cli.ts`가 세운 규약과 같다: 라이브러리는 `process.exit`을 부르지 않는다).
 *
 * ## 질의를 순차로 보낸다
 * 30건을 동시에 던지면 임베딩 provider의 레이트리밋에 걸리고, 실패한 케이스가 지표를 0으로
 * 만들어 "품질 하락"으로 오독된다. eval은 빠를 필요가 없다.
 */
import {
  aggregate,
  RECALL_K,
  round4,
  scoreCase,
  type CaseOutcome,
  type MetricSummary,
} from "./metrics.js";
import { evaluateRegression } from "./baseline-guard.js";
import { goldenSetWarnings, EXPECTED_GOLDEN_SET_SIZE, type GoldenCase } from "./golden-set.js";
import { QUERY_KINDS, type QueryKind } from "./query-kind.js";
import {
  RetrievalReport,
  RETRIEVAL_REPORT_KIND,
  toReportDate,
  type EmbeddingProvenance,
  type QueryKindBreakdown,
  type RetrievalCaseResult,
  type RetrievalMetrics,
} from "./report.js";
import type { SearchFn } from "./search-client.js";

export interface RunRetrievalEvalInput {
  readonly cases: readonly GoldenCase[];
  readonly search: SearchFn;
  /** `/v1/search`에 보낼 `limit`. 스윕 대상이다(T-011 Findings: 오버페치·record당 상한). */
  readonly limit: number;
  readonly baselines: RetrievalMetrics;
  readonly embedding: EmbeddingProvenance;
  /** 리포트 날짜·`generatedAt`의 유일한 출처. 주입해야 테스트가 결정론적이다. */
  readonly now: Date;
  readonly expectedCaseCount?: number;
}

function toBreakdown(summary: MetricSummary): QueryKindBreakdown {
  return {
    caseCount: summary.caseCount,
    "recall@5": summary.recall,
    mrr: summary.mrr,
    ambiguousTieCount: summary.ambiguousTieCount,
  };
}

export async function runRetrievalEval(input: RunRetrievalEvalInput): Promise<RetrievalReport> {
  const expectedCaseCount = input.expectedCaseCount ?? EXPECTED_GOLDEN_SET_SIZE;

  const results: RetrievalCaseResult[] = [];
  const outcomes: CaseOutcome[] = [];
  const byKind = new Map<QueryKind, CaseOutcome[]>(QUERY_KINDS.map((kind) => [kind, []]));

  for (const goldenCase of input.cases) {
    const hits = await input.search({
      query: goldenCase.query,
      limit: input.limit,
      ...(goldenCase.type === undefined ? {} : { type: goldenCase.type }),
    });
    const outcome = scoreCase(hits, goldenCase.expectedRecordIds, RECALL_K);
    outcomes.push(outcome);
    byKind.get(goldenCase.queryKind)?.push(outcome);
    results.push({
      caseId: goldenCase.caseId,
      query: goldenCase.query,
      queryKind: goldenCase.queryKind,
      expectedRecordIds: [...goldenCase.expectedRecordIds],
      rankedRecordIds: [...outcome.rankedRecordIds],
      firstHitRank: outcome.firstHitRank,
      hit: outcome.hit,
      reciprocalRank: round4(outcome.reciprocalRank),
      ambiguousTie: outcome.ambiguousTie,
    });
  }

  const overall = aggregate(outcomes);
  const metrics: RetrievalMetrics = { "recall@5": overall.recall, mrr: overall.mrr };

  const byQueryKind = Object.fromEntries(
    QUERY_KINDS.map((kind) => [kind, toBreakdown(aggregate(byKind.get(kind) ?? []))]),
  ) as Record<QueryKind, QueryKindBreakdown>;

  const warnings = goldenSetWarnings(input.cases, expectedCaseCount);
  if (!input.embedding.trusted) {
    warnings.push(
      `EMBEDDING_PROVIDER=${input.embedding.provider}로 측정했다. 이 수치는 검색 품질이 아니라 ` +
        "BM25 단독 성능에 가깝다(T-006 F-8: fake 벡터의 cosine ≈ 0). 기준선 판정은 하지 않았다.",
    );
  }
  if (overall.ambiguousTieCount > 0) {
    warnings.push(
      `동점 점수 때문에 결과가 흔들릴 수 있는 케이스가 ${String(overall.ambiguousTieCount)}건이다. ` +
        "atlas-local은 같은 점수 후보의 순서를 보장하지 않는다(T-011 F-9) — " +
        "재실행하면 이 케이스들의 판정이 달라질 수 있다. 기준선으로 쓰기 전에 골든셋을 손봐라.",
    );
  }

  return RetrievalReport.parse({
    kind: RETRIEVAL_REPORT_KIND,
    date: toReportDate(input.now),
    generatedAt: input.now.toISOString(),
    embedding: input.embedding,
    config: {
      limit: input.limit,
      k: RECALL_K,
      caseCount: input.cases.length,
      expectedCaseCount,
    },
    metrics,
    byQueryKind,
    baselines: input.baselines,
    regression: evaluateRegression({
      metrics,
      baselines: input.baselines,
      trusted: input.embedding.trusted,
      caseCount: input.cases.length,
    }),
    warnings,
    cases: results,
  });
}
