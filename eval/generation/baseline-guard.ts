/**
 * 회귀 가드. **T-020 Acceptance 3("judge 점수와 리포트가 baselines.json에 기록되고 하락 시
 * exit 1")이 판정하는 대상이 이 파일이다.**
 *
 * T-013·T-016이 세운 구조를 그대로 따른다:
 *   - `checkBaselines` / `evaluateRegression` — 순수 판정 (단위 테스트가 양방향으로 잠근다)
 *   - `exitCodeFor` — 판정 → 종료 코드 (CLI가 이것만 부른다)
 * 그리고 `check-baseline.cli.spec.ts`가 **실제 프로세스를 띄워** 종료 코드를 확인한다.
 * 순수 함수만 테스트하면 "판정은 맞는데 CLI가 exit 0으로 끝내는" 조합을 놓친다.
 *
 * ## 판정 규칙
 * `value < baseline`이면 위반이다. **동률은 통과다** — 기준선은 "이 밑으로 내려가면 안 되는 선"이고
 * 선 위에 서 있는 것은 하락이 아니다. `citationRuleCheck`의 기준선이 1.0이라는 것은
 * specs/05의 "100% 요구"가 그대로 코드가 된 것이다: 한 케이스라도 인용 룰을 어기면 exit 1이다.
 *
 * ## 판정하지 **않는** 경우 — 이 eval에서는 지금 이쪽이 기본값이다
 * 아래 셋은 `pass:false`가 아니라 `evaluated:false`다. "떨어졌다"와 "잴 수 없었다"는 다른
 * 사실이고, 후자를 전자로 접으면 CI가 자격증명 부재를 품질 회귀로 신고하기 시작한다.
 *   - `generator.trusted === false` — 픽스처가 만든 답변의 인용 통과율은 생성 품질이 아니다.
 *   - `judge.trusted === false` — 고정 점수를 내는 judge는 정의상 기준선을 넘거나 못 넘는다.
 *   - `answeredCount === 0` — 답을 낸 케이스가 없다. 0/0을 0.0으로 접으면 항상 회귀다.
 */
import type { BaselinesFile } from "./baselines.js";
import type {
  BaselineViolation,
  GenerationMetrics,
  GenerationReport,
  RegressionVerdict,
} from "./report.js";
import { GENERATION_METRIC_KEYS } from "./report.js";

/** 반올림 자릿수(1e-4)보다 다섯 자리 작다 — 실제 회귀를 삼킬 수 없다. */
export const BASELINE_EPSILON = 1e-9;

/** sysexits.h 관례. 78은 "설정이 틀렸다"이지 "품질이 떨어졌다"가 아니다. */
export const EVAL_EXIT_CODES = {
  OK: 0,
  /** 기준선 하락. specs/05 G4가 머지를 막는 신호다. */
  REGRESSED: 1,
  /** EX_CONFIG — 잴 수 없는 조건(모델·judge 부재·케이스 부재·리포트 손상). */
  NOT_MEASURABLE: 78,
} as const;
export type EvalExitCode = (typeof EVAL_EXIT_CODES)[keyof typeof EVAL_EXIT_CODES];

/**
 * 지표를 기준선과 대조한다. **키는 `GENERATION_METRIC_KEYS`를 순회해서 얻는다** —
 * 필드를 손으로 두 번 적으면 한쪽에 지표가 늘었을 때 다른 쪽이 조용히 안 본다.
 */
export function checkBaselines(
  metrics: GenerationMetrics,
  baselines: GenerationMetrics,
): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  for (const metric of GENERATION_METRIC_KEYS) {
    const value = metrics[metric];
    const baseline = baselines[metric];
    if (value < baseline - BASELINE_EPSILON) {
      violations.push({ metric, value, baseline, delta: value - baseline });
    }
  }
  return violations;
}

export interface RegressionInput {
  readonly metrics: GenerationMetrics;
  readonly baselines: GenerationMetrics;
  readonly generatorTrusted: boolean;
  readonly judgeTrusted: boolean;
  readonly answeredCount: number;
}

export function evaluateRegression(input: RegressionInput): RegressionVerdict {
  if (!input.generatorTrusted) {
    return notEvaluated(
      "답변을 만든 것이 실제 모델이 아니다(픽스처). 이 수치는 생성 품질이 아니라 픽스처의 " +
        "자기 확인이다. 기준선과 비교하지 않는다 " +
        "(specs/05: 실제 모델 호출은 eval 계층에서만 — 그 호출이 없으면 판정도 없다).",
    );
  }
  if (!input.judgeTrusted) {
    return notEvaluated(
      "judge가 실제 모델이 아니다(픽스처). 고정 점수는 faithfulness·usefulness가 아니다. " +
        "인용 룰체크만 실제로 잰 상태이므로 셋 중 둘이 허수인 리포트로 판정하지 않는다.",
    );
  }
  if (input.answeredCount === 0) {
    return notEvaluated(
      "답을 낸 케이스가 0건이다(전부 found:false이거나 케이스가 없다). " +
        "0/0을 0.0으로 접으면 언제나 회귀가 되므로 판정하지 않는다.",
    );
  }
  const violations = checkBaselines(input.metrics, input.baselines);
  return { evaluated: true, pass: violations.length === 0, violations, reason: null };
}

function notEvaluated(reason: string): RegressionVerdict {
  return { evaluated: false, pass: false, violations: [], reason };
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

/** `BaselinesFile` → 비교에 쓰는 지표 묶음. 호출부에서 `.generation`을 반복하지 않게 한다. */
export function generationBaselines(file: BaselinesFile): GenerationMetrics {
  return file.generation;
}

/** 콘솔 요약 한 덩어리. CLI 두 개가 같은 문장을 쓰게 한다. */
export function formatVerdict(report: GenerationReport): string {
  const lines: string[] = [
    `[eval:generation] ${report.date} — 케이스 ${String(report.config.caseCount)}건 ` +
      `(답변 ${String(report.diagnostics.answeredCount)} / 미발견 ${String(report.diagnostics.notFoundCount)}), ` +
      `생성=${report.generator.provider}/${report.generator.model}` +
      `${report.generator.trusted ? "" : " (신뢰 불가)"}, ` +
      `judge=${report.judge.provider}/${report.judge.model}` +
      `${report.judge.trusted ? "" : " (신뢰 불가)"}`,
  ];
  for (const metric of GENERATION_METRIC_KEYS) {
    lines.push(
      `  ${metric.padEnd(18)} ${report.metrics[metric].toFixed(4)}  ` +
        `(기준선 ${report.baselines[metric].toFixed(4)})`,
    );
  }
  lines.push(
    `  · 주장 문장 ${String(report.diagnostics.claimSentences)} / ` +
      `인용된 문장 ${String(report.diagnostics.citedSentences)} / ` +
      `groundingViolation ${String(report.diagnostics.groundingViolations)} / ` +
      `지어낸 인용 ${String(report.diagnostics.unknownCitations)}`,
    `  · 임계값 시나리오(Eval 2-c) ${String(report.diagnostics.thresholdScenarioPass)}/` +
      `${String(report.diagnostics.thresholdScenarioCount)} found:false`,
  );
  for (const result of report.cases) {
    if (result.citationRuleCheck === false || result.found !== result.expectFound) {
      lines.push(
        `  ✗ ${result.caseId} found=${String(result.found)}(기대 ${String(result.expectFound)}) ` +
          `룰체크=${String(result.citationRuleCheck)} ` +
          `무인용 ${String(result.missingCitationSentences)} / 지어냄 ${String(result.unknownCitationSentences)}` +
          (result.unknownCitations.length > 0 ? ` ${result.unknownCitations.join(", ")}` : ""),
      );
    }
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
export function recheckReport(
  report: GenerationReport,
  baselines: GenerationMetrics,
): GenerationReport {
  return {
    ...report,
    baselines,
    regression: evaluateRegression({
      metrics: report.metrics,
      baselines,
      generatorTrusted: report.generator.trusted,
      judgeTrusted: report.judge.trusted,
      answeredCount: report.diagnostics.answeredCount,
    }),
  };
}
