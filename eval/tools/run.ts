/**
 * 러너 본체. 시나리오 × selector × 반복 → `ToolsReport`.
 *
 * **파일도 env도 모른다.** 시나리오 배열·카탈로그·`ToolSelector`만 받는다 — 그래야 단위
 * 테스트가 모델 없이 러너의 집계·경고·판정을 전부 돌려 볼 수 있고, `run.cli.ts`는 컴포지션
 * 루트로만 남는다(T-013이 따른 `scripts/seed.cli.ts` 규약: 라이브러리는 `process.exit`을 부르지 않는다).
 *
 * ## 호출을 순차로 보낸다
 * 60회를 동시에 던지면 모델 provider의 레이트리밋에 걸리고, 실패한 시도가 지표를 0으로 만들어
 * "선택률 하락"으로 오독된다. eval은 빠를 필요가 없다.
 *
 * ## selector 실패는 오답이 아니다
 * `SelectorCallError`를 삼키지 않고 그대로 올린다. 429 하나를 "도구를 못 골랐다"로 세면
 * 회귀 리포트가 네트워크 사고를 품질 저하로 신고한다 — CLI가 이 오류를 69(EX_UNAVAILABLE)로
 * 옮긴다(T-013의 `EvalSearchError` → 69와 같은 규약).
 */
import { evaluateRegression, UNRATIFIED_CONTRACT_NOTE } from "./baseline-guard.js";
import { toolNames, type ToolCatalog } from "./catalog.js";
import {
  ToolsReport,
  TOOLS_REPORT_KIND,
  toReportDate,
  type ToolCaseResult,
  type ToolsMetrics,
} from "./report.js";
import { aggregate, scoreScenario } from "./score.js";
import { scenarioWarnings, type Scenario } from "./scenarios.js";
import type { ToolChoice, ToolSelector } from "./selector.js";

export interface RunToolsEvalInput {
  readonly scenarios: readonly Scenario[];
  readonly catalog: ToolCatalog;
  readonly selector: ToolSelector;
  /** 시나리오당 반복 횟수(T-016 Scope: 3회). */
  readonly repeats: number;
  readonly baselines: ToolsMetrics;
  /** 리포트 날짜·`generatedAt`의 유일한 출처. 주입해야 테스트가 결정론적이다. */
  readonly now: Date;
  readonly expectedScenarioCount: number;
}

export async function runToolsEval(input: RunToolsEvalInput): Promise<ToolsReport> {
  const cases: ToolCaseResult[] = [];

  for (const scenario of input.scenarios) {
    const choices: ToolChoice[] = [];
    for (let attempt = 1; attempt <= input.repeats; attempt += 1) {
      choices.push(
        await input.selector.select({
          prompt: scenario.prompt,
          catalog: input.catalog,
          attempt,
        }),
      );
    }
    cases.push(scoreScenario(scenario, choices));
  }

  const summary = aggregate(cases, input.repeats);

  const warnings = [
    ...scenarioWarnings(input.scenarios, input.catalog, input.expectedScenarioCount),
    ...summary.warnings,
  ];
  if (!input.selector.provenance.trusted) {
    warnings.push(
      `selector=${input.selector.provenance.provider}로 측정했다. 실제 모델이 고른 것이 아니므로 ` +
        "이 수치는 도구 선택률이 아니다(오라클은 정의상 1.0을 낸다). 기준선 판정은 하지 않았다.",
    );
  }
  if (summary.diagnostics.stability < 1 && summary.diagnostics.attempts > 0) {
    warnings.push(
      `반복 회차마다 다른 도구를 고른 시나리오가 있다(일관성 ${summary.diagnostics.stability.toFixed(4)}). ` +
        "같은 프롬프트에 답이 흔들린다는 것은 description이 그 경계를 못 긋고 있다는 뜻이다 — " +
        "그 상태의 수치로 기준선을 확정하지 마라.",
    );
  }
  // G6: 비준 전에는 어떤 수치도 기준선 후보가 아니다. 조건 없이 싣는다.
  warnings.push(UNRATIFIED_CONTRACT_NOTE);

  return ToolsReport.parse({
    kind: TOOLS_REPORT_KIND,
    date: toReportDate(input.now),
    generatedAt: input.now.toISOString(),
    selector: input.selector.provenance,
    catalog: {
      toolCount: input.catalog.tools.length,
      toolNames: toolNames(input.catalog),
      descriptionSha256: input.catalog.descriptionSha256,
    },
    config: {
      repeats: input.repeats,
      scenarioCount: input.scenarios.length,
      expectedScenarioCount: input.expectedScenarioCount,
    },
    metrics: summary.metrics,
    diagnostics: summary.diagnostics,
    byExpectedTool: summary.byExpectedTool,
    baselines: input.baselines,
    regression: evaluateRegression({
      metrics: summary.metrics,
      baselines: input.baselines,
      trusted: input.selector.provenance.trusted,
      scenarioCount: input.scenarios.length,
    }),
    confusions: summary.confusions,
    warnings,
    cases,
  });
}
