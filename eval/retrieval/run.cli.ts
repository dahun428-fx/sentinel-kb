/**
 * `pnpm eval:retrieval` 진입점 (specs/05 Eval 1, T-013).
 *
 * **컴포지션 루트다** — env를 읽는 유일한 지점이고, 종료 코드를 정하는 유일한 지점이다.
 * `scripts/seed.cli.ts`가 세운 규약을 그대로 따른다: 라이브러리는 `process.exit`을 부르지 않는다.
 *
 * 사용법:
 *   pnpm eval:retrieval                          # 기본 (limit=5, project=sentinel-kb)
 *   pnpm eval:retrieval --limit=20               # 후보/최종 K 스윕
 *   pnpm eval:retrieval --base-url=http://...    # 원격 core-api 대상
 *   pnpm eval:retrieval --allow-fake-embeddings  # 판정 없이 파이프라인만 확인
 *
 * ## ⚠️ 자격증명이 없으면 재지 않는다 (EX_CONFIG 78로 거절)
 * `EMBEDDING_PROVIDER=fake`면 이 CLI는 **아무것도 재지 않고 78로 끝난다.** 해시 벡터는 서로 다른
 * 텍스트 간 cosine ≈ 0이라(T-006 F-8, 실측 −0.00007) 지표가 검색 품질이 아니라 BM25 단독 성능이
 * 되기 때문이다 — T-012 검증자가 그 귀결을 실증했다(벡터 경로를 융합에서 제거해도 통합 테스트
 * 11개 전부 통과, `vectorRank`·`textRank`가 동시에 non-null인 hit 0건).
 * `scripts/seed.cli.ts`가 같은 이유로 fake 적재를 거절하는 것과 같은 게이트다.
 *
 * 종료 코드:
 *   0  판정했고 기준선 통과
 *   1  **기준선 하락** (specs/05 G4 — 머지 금지)
 *   69 EX_UNAVAILABLE — DB·core-api에 닿지 못함
 *   78 EX_CONFIG — 잴 수 없는 조건(fake 임베딩, 케이스 0건, 인자·env 오설정)
 */
import { parseApiKeys, readEmbedderConfig } from "@sentinel/core";
import { closeDb, DbConnectionError, getDb } from "@sentinel/core/db";

import {
  assertMeasurable,
  isTrustedProvider,
  parseRunArgs,
  resolveEvalApiKey,
  EvalArgsError,
} from "./args.js";
import { EVAL_EXIT_CODES, exitCodeFor, formatVerdict, retrievalBaselines } from "./baseline-guard.js";
import { readBaselines } from "./baselines.js";
import { loadGoldenSet } from "./golden-set.js";
import { REPO_ROOT, writeRetrievalReport } from "./report-io.js";
import { runRetrievalEval } from "./run.js";
import { createSearchClient, EvalSearchError } from "./search-client.js";

const EXIT_UNAVAILABLE = 69;

async function main(): Promise<number> {
  const args = parseRunArgs(process.argv.slice(2), process.env);
  const apiKeys = parseApiKeys(process.env["API_KEYS"]);
  const apiKey = resolveEvalApiKey(apiKeys, args.project);
  const embedderConfig = readEmbedderConfig(process.env);

  assertMeasurable(embedderConfig.provider, args.allowFakeEmbeddings);
  const trusted = isTrustedProvider(embedderConfig.provider);

  const baselines = retrievalBaselines(await readBaselines());
  const db = await getDb();
  const cases = await loadGoldenSet(db);

  const report = await runRetrievalEval({
    cases,
    search: createSearchClient({ baseUrl: args.baseUrl, apiKey }),
    limit: args.limit,
    baselines,
    embedding: {
      provider: embedderConfig.provider,
      version: embedderConfig.version,
      dim: embedderConfig.dim,
      trusted,
    },
    now: new Date(),
    expectedCaseCount: args.expectedCaseCount,
  });

  const path = await writeRetrievalReport(report, REPO_ROOT);
  console.log(formatVerdict(report));
  console.log(`[eval:retrieval] 리포트: ${path}`);
  return exitCodeFor(report.regression);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof EvalArgsError) {
    console.error(`[eval:retrieval] EVAL_CONFIG_INVALID: ${error.message}`);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof DbConnectionError) {
    console.error(`[eval:retrieval] ${error.code}: ${error.message}`);
    process.exitCode =
      error.code === "DB_CONNECTION_FAILED" ? EXIT_UNAVAILABLE : EVAL_EXIT_CODES.NOT_MEASURABLE;
  } else if (error instanceof EvalSearchError) {
    // 검색이 실패한 채로 낸 지표는 "품질이 떨어졌다"가 아니라 "재지 못했다"이다.
    console.error(`[eval:retrieval] SEARCH_FAILED: ${error.message}`);
    process.exitCode = EXIT_UNAVAILABLE;
  } else {
    console.error("[eval:retrieval] EVAL_FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = EVAL_EXIT_CODES.NOT_MEASURABLE;
  }
} finally {
  await closeDb();
}
