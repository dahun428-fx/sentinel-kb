/**
 * **테스트 전용** 리포트 빌더. 프로덕션 경로는 이 파일을 import하지 않는다
 * (`run.ts`가 만드는 리포트만이 관측의 산물이다). T-013·T-016의 `report-fixture.ts` 규약.
 *
 * 회귀 가드를 양방향으로 확인하려면 **기준선보다 낮은 리포트를 일부러 만들어야** 한다.
 * 그 리포트는 실제로 돌려서는 만들 수 없으므로(judge 부재) 여기서 만든다.
 */
import type { GenerationMetrics, GenerationReport } from "./report.js";

export interface ReportFixtureOptions {
  readonly metrics?: Partial<GenerationMetrics>;
  readonly baselines?: GenerationMetrics;
  readonly generatorTrusted?: boolean;
  readonly judgeTrusted?: boolean;
  readonly answeredCount?: number;
  readonly date?: string;
}

/**
 * 스키마를 만족하는 최소 리포트. `regression`은 **판정 전 자리표시자**다 —
 * `check-baseline.cli.ts`가 현재 기준선으로 다시 판정하므로 여기 값은 결과에 영향이 없다.
 * (그 무관함 자체가 테스트 대상이다: 리포트에 `pass:true`가 박혀 있어도 가드는 속지 않는다.)
 */
export function makeReportFixture(options: ReportFixtureOptions = {}): GenerationReport {
  const metrics: GenerationMetrics = {
    citationRuleCheck: 1,
    faithfulness: 4.5,
    usefulness: 4,
    ...options.metrics,
  };
  const baselines = options.baselines ?? {
    citationRuleCheck: 1,
    faithfulness: 4,
    usefulness: 3.5,
  };
  const generatorTrusted = options.generatorTrusted ?? true;
  const judgeTrusted = options.judgeTrusted ?? true;
  const answeredCount = options.answeredCount ?? 10;
  const date = options.date ?? "2026-08-23";

  return {
    kind: "generation",
    date,
    generatedAt: `${date}T00:00:00.000Z`,
    generator: generatorTrusted
      ? { provider: "core-api", model: "test-model", trusted: true }
      : { provider: "fixture", model: "fixture", trusted: false },
    judge: judgeTrusted
      ? { provider: "anthropic", model: "test-judge", trusted: true }
      : { provider: "fixture", model: "fixture", trusted: false },
    config: { caseCount: 15, expectedCaseCount: 15 },
    metrics,
    diagnostics: {
      caseCount: 15,
      answeredCount,
      notFoundCount: 15 - answeredCount,
      thresholdScenarioCount: 5,
      thresholdScenarioPass: 5,
      groundingViolations: 0,
      claimSentences: 40,
      citedSentences: 40,
      unknownCitations: 0,
    },
    baselines,
    // 일부러 낙관적으로 박아 둔다 — 가드가 리포트의 주장을 믿지 않는지 확인하는 미끼다.
    regression: { evaluated: true, pass: true, violations: [], reason: null },
    warnings: [],
    cases: [],
  };
}
