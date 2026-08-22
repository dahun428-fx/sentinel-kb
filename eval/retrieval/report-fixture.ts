/**
 * **테스트 전용** 리포트 빌더. 프로덕션 경로는 이 파일을 import하지 않는다
 * (`run.ts`가 만드는 리포트만이 관측의 산물이다).
 *
 * 회귀 가드를 양방향으로 확인하려면 **기준선보다 낮은 리포트를 일부러 만들어야** 한다.
 * 그 리포트는 검색을 돌려서는 만들 수 없으므로(자격증명 부재, T-013 BLOCKED) 여기서 만든다.
 *
 * ## 점수를 어긋나게 심는다 (T-011 F-9)
 * 기본 케이스의 hit 점수는 전부 서로 다른 값이다. 동점을 넣으면 `ambiguousTie` 경고가 붙고
 * 그 자체가 테스트의 관심사가 되므로, 동점은 **그것을 다루는 테스트에서만** 명시적으로 심는다.
 */
import type { RetrievalReport, RetrievalMetrics } from "./report.js";

export interface ReportFixtureOptions {
  readonly metrics?: RetrievalMetrics;
  readonly baselines?: RetrievalMetrics;
  readonly trusted?: boolean;
  readonly caseCount?: number;
  readonly date?: string;
}

/**
 * 스키마를 만족하는 최소 리포트. `regression`은 **판정 전 자리표시자**다 —
 * `check-baseline.cli.ts`가 현재 기준선으로 다시 판정하므로 여기 값은 결과에 영향이 없다.
 * (그 무관함 자체가 테스트 대상이다: 리포트에 `pass:true`가 박혀 있어도 가드는 속지 않는다.)
 */
export function makeReportFixture(options: ReportFixtureOptions = {}): RetrievalReport {
  const metrics = options.metrics ?? { "recall@5": 0.9, mrr: 0.8 };
  const baselines = options.baselines ?? { "recall@5": 0.8, mrr: 0.65 };
  const trusted = options.trusted ?? true;
  const caseCount = options.caseCount ?? 30;
  const date = options.date ?? "2026-08-23";

  return {
    kind: "retrieval",
    date,
    generatedAt: `${date}T00:00:00.000Z`,
    embedding: { provider: trusted ? "voyage" : "fake", version: 1, dim: 1024, trusted },
    config: { limit: 5, k: 5, caseCount, expectedCaseCount: 30 },
    metrics,
    byQueryKind: {
      identifier: { caseCount, "recall@5": metrics["recall@5"], mrr: metrics.mrr, ambiguousTieCount: 0 },
      "korean-prose": { caseCount: 0, "recall@5": 0, mrr: 0, ambiguousTieCount: 0 },
      other: { caseCount: 0, "recall@5": 0, mrr: 0, ambiguousTieCount: 0 },
    },
    baselines,
    // 일부러 낙관적으로 박아 둔다 — 가드가 리포트의 주장을 믿지 않는지 확인하는 미끼다.
    regression: { evaluated: true, pass: true, violations: [], reason: null },
    warnings: [],
    cases: [],
  };
}
