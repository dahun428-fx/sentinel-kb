/**
 * 회귀 가드. **T-016 Acceptance 3("기준선 하락 시 exit 1")이 판정하는 대상이 이 파일이다.**
 *
 * T-013(`eval/retrieval/baseline-guard.ts`)이 세운 구조를 그대로 따른다:
 *   - `checkBaselines` / `evaluateRegression` — 순수 판정 (단위 테스트가 양방향으로 잠근다)
 *   - `exitCodeFor` — 판정 → 종료 코드 (CLI가 이것만 부른다)
 * 그리고 `check-baseline.cli.spec.ts`가 **실제 프로세스를 띄워** 종료 코드를 확인한다.
 * 순수 함수만 테스트하면 "판정은 맞는데 CLI가 exit 0으로 끝내는" 조합을 놓친다.
 *
 * ## 판정 규칙
 * `value < baseline`이면 위반이다. **동률은 통과다** — 기준선은 "이 밑으로 내려가면 안 되는 선"이고
 * 선 위에 서 있는 것은 하락이 아니다. 부동소수 꼬리를 `EPSILON`만큼 봐 주지만, 지표는 리포트에
 * 적히기 전에 이미 소수 4자리로 반올림되므로(score.round4) 1e-9는 실제 회귀를 삼키지 못한다.
 *
 * ## 판정하지 **않는** 경우 — 이 eval에서는 이쪽이 기본값이다
 * 아래 둘은 `pass:false`가 아니라 `evaluated:false`다. "떨어졌다"와 "잴 수 없었다"는 다른
 * 사실이고, 후자를 전자로 접으면 CI가 selector 부재를 품질 회귀로 신고하기 시작한다.
 *   - `selector.trusted === false` — 오라클·스크립트 selector의 수치는 도구 선택률이 아니다.
 *     **오라클은 정의상 1.0을 낸다** — 그 1.0이 기준선 통과로 읽히는 것이 이 가드가 막는 첫 번째 거짓이다.
 *   - `scenarioCount === 0` — 잰 시나리오가 없다. 0/0을 0.0으로 접으면 항상 회귀다.
 *
 * ## ⚠️ 기준선을 **확정하기 전에** 비준이 선행돼야 한다 (G6)
 * 지금 도구 계약에는 인간 비준을 기다리는 이탈이 4건 있다(`UNRATIFIED_CONTRACT_NOTE`).
 * 비준 결과에 따라 description이 바뀌면 이 eval이 재는 대상이 바뀌고, 그 전에 잰 수치는
 * 기준선으로 쓸 수 없다. 그래서 그 사실을 리포트 `warnings`에 **항상** 싣는다.
 */
import type { BaselinesFile } from "./baselines.js";
import type {
  BaselineViolation,
  RegressionVerdict,
  ToolsMetrics,
  ToolsReport,
} from "./report.js";
import { TOOLS_METRIC_KEYS } from "./report.js";

/** 반올림 자릿수(1e-4)보다 다섯 자리 작다 — 실제 회귀를 삼킬 수 없다. */
export const BASELINE_EPSILON = 1e-9;

/** sysexits.h 관례. 78은 "설정이 틀렸다"이지 "품질이 떨어졌다"가 아니다. */
export const EVAL_EXIT_CODES = {
  OK: 0,
  /** 기준선 하락. specs/05 G4가 머지를 막는 신호다. */
  REGRESSED: 1,
  /** EX_CONFIG — 잴 수 없는 조건(selector 부재·시나리오 부재·리포트 손상). */
  NOT_MEASURABLE: 78,
} as const;
export type EvalExitCode = (typeof EVAL_EXIT_CODES)[keyof typeof EVAL_EXIT_CODES];

/**
 * **미비준 이탈 4건.** specs/07의 도구 계약과 `packages/mcp`의 구현이 지금 갈라져 있고,
 * 넷 다 인간 승인 대기다(G6). 비준 결과가 description을 바꾸면 이 리포트의 수치는 무효다.
 * 리포트를 읽는 사람이 이 사실을 모른 채 기준선을 확정하는 것을 막기 위해 항상 싣는다.
 */
export const UNRATIFIED_CONTRACT_NOTE =
  "⚠️ 도구 계약에 미비준 이탈이 4건 있다(G6, 인간 승인 대기): " +
  "(1) search_knowledge의 limit을 3으로 클램프(specs/07:10은 기본 5, 상한 미정 — T-015 F-1), " +
  "(2) 응답에서 절대 score 제거(specs/07:11은 score 포함), " +
  "(3) 응답이 JSON이 아니라 평문 렌더링(specs/07:11의 응답 형상과 다름), " +
  "(4) get_record가 relations를 함께 낸다(specs/07:16의 '전체 레코드'에 없던 필드). " +
  "비준 결과에 따라 description이 바뀌면 이 eval이 재는 대상이 바뀌고 여기서 나온 수치는 기준선이 될 수 없다 " +
  "— **비준이 기준선 확정보다 먼저다.**";

/**
 * 지표를 기준선과 대조한다. **키는 `TOOLS_METRIC_KEYS`를 순회해서 얻는다** —
 * 필드를 손으로 두 번 적으면 한쪽에 지표가 늘었을 때 다른 쪽이 조용히 안 본다.
 */
export function checkBaselines(
  metrics: ToolsMetrics,
  baselines: ToolsMetrics,
): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  for (const metric of TOOLS_METRIC_KEYS) {
    const value = metrics[metric];
    const baseline = baselines[metric];
    if (value < baseline - BASELINE_EPSILON) {
      violations.push({ metric, value, baseline, delta: value - baseline });
    }
  }
  return violations;
}

export interface RegressionInput {
  readonly metrics: ToolsMetrics;
  readonly baselines: ToolsMetrics;
  readonly trusted: boolean;
  readonly scenarioCount: number;
}

export function evaluateRegression(input: RegressionInput): RegressionVerdict {
  if (!input.trusted) {
    return {
      evaluated: false,
      pass: false,
      violations: [],
      reason:
        "selector가 실제 모델이 아니다(oracle/scripted). 이 수치는 도구 선택률이 아니라 픽스처의 " +
        "자기 확인이고, 오라클은 정의상 1.0을 낸다. 기준선과 비교하지 않는다 " +
        "(specs/05: 실제 모델 호출은 eval 계층에서만 — 그 호출이 없으면 판정도 없다).",
    };
  }
  if (input.scenarioCount === 0) {
    return {
      evaluated: false,
      pass: false,
      violations: [],
      reason: `시나리오가 0건이다(${"eval/tools/scenarios.json"}). 잰 것이 없으므로 판정하지 않는다.`,
    };
  }
  const violations = checkBaselines(input.metrics, input.baselines);
  return { evaluated: true, pass: violations.length === 0, violations, reason: null };
}

/**
 * 판정 → 종료 코드.
 *   - 판정했고 통과 → 0
 *   - 판정했고 하락 → **1** (Acceptance 3)
 *   - 판정 못 함 → 78. 0으로 끝내면 "판정 불가"가 "통과"로 읽힌다.
 */
export function exitCodeFor(verdict: RegressionVerdict): EvalExitCode {
  if (!verdict.evaluated) return EVAL_EXIT_CODES.NOT_MEASURABLE;
  return verdict.pass ? EVAL_EXIT_CODES.OK : EVAL_EXIT_CODES.REGRESSED;
}

/** `BaselinesFile` → 비교에 쓰는 지표 묶음. 호출부에서 `.tools`를 반복하지 않게 한다. */
export function toolsBaselines(file: BaselinesFile): ToolsMetrics {
  return file.tools;
}

/** 콘솔 요약 한 덩어리. CLI 두 개가 같은 문장을 쓰게 한다. */
export function formatVerdict(report: ToolsReport): string {
  const lines: string[] = [
    `[eval:tools] ${report.date} — 시나리오 ${String(report.config.scenarioCount)}건 × ` +
      `${String(report.config.repeats)}회 = ${String(report.diagnostics.attempts)}시도, ` +
      `selector=${report.selector.provider}/${report.selector.model}` +
      `${report.selector.trusted ? "" : " (신뢰 불가)"}`,
    `  계약 지문 ${report.catalog.descriptionSha256.slice(0, 12)}… (도구 ${String(report.catalog.toolCount)}종) ` +
      "— 이 값이 달라진 리포트끼리는 같은 계약을 잰 것이 아니다(G6).",
  ];
  for (const metric of TOOLS_METRIC_KEYS) {
    lines.push(
      `  ${metric.padEnd(18)} ${report.metrics[metric].toFixed(4)}  (기준선 ${report.baselines[metric].toFixed(4)})`,
    );
  }
  lines.push(
    `  · 도구만 맞음 ${report.diagnostics.toolAccuracy.toFixed(4)} / ` +
      `인자까지 ${report.diagnostics.argAccuracy.toFixed(4)} / ` +
      `반복 일관성 ${report.diagnostics.stability.toFixed(4)}`,
  );
  for (const breakdown of report.byExpectedTool) {
    lines.push(
      `  · ${(breakdown.expectedTool ?? "(도구 없음이 정답)").padEnd(20)} ` +
        `n=${String(breakdown.scenarioCount).padStart(2)}  ` +
        `정확도=${breakdown.selectionAccuracy.toFixed(4)}  도구만=${breakdown.toolAccuracy.toFixed(4)}`,
    );
  }
  for (const confusion of report.confusions) {
    lines.push(
      `  ✗ ${confusion.scenarioId} 기대=${confusion.expectedTool ?? "(없음)"} → ` +
        `선택=${confusion.chosenTool ?? "(없음)"} ×${String(confusion.count)}` +
        (confusion.missingArgs.length > 0 ? ` 인자 누락: ${confusion.missingArgs.join(", ")}` : "") +
        (confusion.wrongArgs.length > 0
          ? ` 인자 불일치: ${confusion.wrongArgs.map((arg) => `${arg.name}=${arg.actual ?? "(없음)"}≠${arg.expected}`).join(", ")}`
          : ""),
    );
  }
  for (const warning of report.warnings) lines.push(`  ⚠️ ${warning}`);
  if (!report.regression.evaluated) {
    lines.push(`  판정 불가: ${report.regression.reason ?? ""}`);
  } else if (report.regression.pass) {
    lines.push("  기준선 통과.");
  } else {
    for (const violation of report.regression.violations) {
      lines.push(
        `  ✗ ${violation.metric} ${violation.value.toFixed(4)} < 기준선 ${violation.baseline.toFixed(4)} ` +
          `(${violation.delta.toFixed(4)})`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * 이미 만들어진 리포트를 **현재 기준선**으로 다시 판정한다.
 *
 * 리포트 안에 박힌 `baselines` 사본이 아니라 `eval/baselines.json`을 새로 읽어 넣는 것이
 * 요점이다 — 사람이 기준선을 올린 뒤에는 과거 리포트도 새 선으로 읽혀야 한다.
 * 모델을 다시 부르지 않으므로 회귀 가드 자체를 결정론적으로 재현·테스트할 수 있다.
 */
export function recheckReport(report: ToolsReport, baselines: ToolsMetrics): ToolsReport {
  return {
    ...report,
    baselines,
    regression: evaluateRegression({
      metrics: report.metrics,
      baselines,
      trusted: report.selector.trusted,
      scenarioCount: report.config.scenarioCount,
    }),
  };
}
