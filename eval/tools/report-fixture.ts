/**
 * **테스트 전용** 리포트 빌더. 프로덕션 경로는 이 파일을 import하지 않는다
 * (`run.ts`가 만드는 리포트만이 관측의 산물이다). T-013 `eval/retrieval/report-fixture.ts` 규약.
 *
 * 회귀 가드를 양방향으로 확인하려면 **기준선보다 낮은 리포트를 일부러 만들어야** 한다.
 * 그 리포트는 모델을 돌려서는 만들 수 없으므로(selector 부재) 여기서 만든다.
 */
import type { ToolsMetrics, ToolsReport } from "./report.js";

export interface ReportFixtureOptions {
  readonly metrics?: ToolsMetrics;
  readonly baselines?: ToolsMetrics;
  readonly trusted?: boolean;
  readonly scenarioCount?: number;
  readonly date?: string;
}

/**
 * 스키마를 만족하는 최소 리포트. `regression`은 **판정 전 자리표시자**다 —
 * `check-baseline.cli.ts`가 현재 기준선으로 다시 판정하므로 여기 값은 결과에 영향이 없다.
 * (그 무관함 자체가 테스트 대상이다: 리포트에 `pass:true`가 박혀 있어도 가드는 속지 않는다.)
 */
export function makeReportFixture(options: ReportFixtureOptions = {}): ToolsReport {
  const metrics = options.metrics ?? { selectionAccuracy: 0.9 };
  const baselines = options.baselines ?? { selectionAccuracy: 0.85 };
  const trusted = options.trusted ?? true;
  const scenarioCount = options.scenarioCount ?? 20;
  const date = options.date ?? "2026-08-23";
  const repeats = 3;

  return {
    kind: "tools",
    date,
    generatedAt: `${date}T00:00:00.000Z`,
    selector: trusted
      ? { provider: "anthropic", model: "test-model", trusted: true }
      : { provider: "oracle", model: "oracle", trusted: false },
    catalog: {
      toolCount: 5,
      toolNames: [
        "search_knowledge",
        "get_record",
        "record_knowledge",
        "suggest_resolution",
        "give_feedback",
      ],
      descriptionSha256: "0".repeat(64),
    },
    config: { repeats, scenarioCount, expectedScenarioCount: 20 },
    metrics,
    diagnostics: {
      toolAccuracy: metrics.selectionAccuracy,
      argAccuracy: 1,
      stability: 1,
      scenarioCount,
      repeats,
      attempts: scenarioCount * repeats,
    },
    byExpectedTool: [],
    baselines,
    // 일부러 낙관적으로 박아 둔다 — 가드가 리포트의 주장을 믿지 않는지 확인하는 미끼다.
    regression: { evaluated: true, pass: true, violations: [], reason: null },
    confusions: [],
    warnings: [],
    cases: [],
  };
}
