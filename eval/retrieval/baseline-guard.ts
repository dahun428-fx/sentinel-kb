/**
 * 회귀 가드. **T-013 Acceptance 2가 판정하는 대상이 이 파일이다.**
 *
 * 요구는 "기준선보다 낮으면 exit 1"이다. 그런데 종료 코드는 프로세스의 성질이고 순수 함수로
 * 테스트할 수 없으므로 둘로 나눈다:
 *   - `checkBaselines` / `evaluateRegression` — 순수 판정 (단위 테스트가 양방향으로 잠근다)
 *   - `exitCodeFor` — 판정 → 종료 코드 (CLI가 이것만 부른다)
 * 그리고 `check-baseline.cli.spec.ts`가 **실제 프로세스를 띄워** 두 방향의 종료 코드를 확인한다.
 * 순수 함수만 테스트하면 "판정은 맞는데 CLI가 exit 0으로 끝내는" 조합을 놓친다.
 *
 * ## 판정 규칙
 * `value < baseline`이면 위반이다. **동률(`value === baseline`)은 통과다** — 기준선은
 * "이 밑으로 내려가면 안 되는 선"이고 선 위에 서 있는 것은 하락이 아니다.
 *
 * 부동소수 꼬리로 0.8 == 0.8이 어긋나는 것을 막기 위해 `EPSILON`만큼 봐 준다. 지표는 리포트에
 * 적히기 전에 이미 소수 4자리로 반올림되므로(metrics.round4) 1e-9는 실제 회귀를 절대 삼키지
 * 못한다 — 삼킬 수 있는 최소 회귀는 1e-4다.
 *
 * ## 판정하지 **않는** 경우
 * 아래 둘은 `pass:false`가 아니라 `evaluated:false`다. "떨어졌다"와 "잴 수 없었다"는 다른
 * 사실이고, 후자를 전자로 접으면 CI가 자격증명 부재를 품질 회귀로 신고하기 시작한다.
 *   - `embedding.trusted === false` — fake 임베딩 수치는 검색 품질이 아니다(T-006 F-8)
 *   - `config.caseCount === 0` — 잰 케이스가 없다. 0/0을 0.0으로 접으면 항상 회귀다
 */
import type { BaselinesFile } from "./baselines.js";
import type {
  BaselineViolation,
  RegressionVerdict,
  RetrievalMetrics,
  RetrievalReport,
} from "./report.js";
import { RETRIEVAL_METRIC_KEYS } from "./report.js";

/** 반올림 자릿수(1e-4)보다 다섯 자리 작다 — 실제 회귀를 삼킬 수 없다. */
export const BASELINE_EPSILON = 1e-9;

/** sysexits.h 관례를 따른다. 78은 "설정이 틀렸다"이지 "품질이 떨어졌다"가 아니다. */
export const EVAL_EXIT_CODES = {
  OK: 0,
  /** 기준선 하락. specs/05 G4가 머지를 막는 신호다. */
  REGRESSED: 1,
  /** EX_CONFIG — 잴 수 없는 조건(자격증명·케이스 부재·리포트 손상). */
  NOT_MEASURABLE: 78,
} as const;
export type EvalExitCode = (typeof EVAL_EXIT_CODES)[keyof typeof EVAL_EXIT_CODES];

/**
 * 지표를 기준선과 대조한다. **키는 `RETRIEVAL_METRIC_KEYS`를 순회해서 얻는다** —
 * 필드를 손으로 두 번 적으면 한쪽에 지표가 늘었을 때 다른 쪽이 조용히 안 본다.
 */
export function checkBaselines(
  metrics: RetrievalMetrics,
  baselines: RetrievalMetrics,
): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  for (const metric of RETRIEVAL_METRIC_KEYS) {
    const value = metrics[metric];
    const baseline = baselines[metric];
    if (value < baseline - BASELINE_EPSILON) {
      violations.push({ metric, value, baseline, delta: value - baseline });
    }
  }
  return violations;
}

export interface RegressionInput {
  readonly metrics: RetrievalMetrics;
  readonly baselines: RetrievalMetrics;
  readonly trusted: boolean;
  readonly caseCount: number;
}

export function evaluateRegression(input: RegressionInput): RegressionVerdict {
  if (!input.trusted) {
    return {
      evaluated: false,
      pass: false,
      violations: [],
      reason:
        "임베딩 provider가 신뢰할 수 없다(fake). 해시 벡터는 서로 다른 텍스트 간 cosine이 0 근처라 " +
        "이 수치는 검색 품질이 아니라 BM25 단독 성능이다(T-006 F-8, T-012 검증). 기준선과 비교하지 않는다.",
    };
  }
  if (input.caseCount === 0) {
    return {
      evaluated: false,
      pass: false,
      violations: [],
      reason:
        "승인된 골든셋 케이스가 0건이다(eval_cases, approvedBy:\"human\"). 잰 것이 없으므로 판정하지 않는다.",
    };
  }
  const violations = checkBaselines(input.metrics, input.baselines);
  return { evaluated: true, pass: violations.length === 0, violations, reason: null };
}

/**
 * 판정 → 종료 코드.
 *   - 판정했고 통과 → 0
 *   - 판정했고 하락 → **1** (Acceptance 2)
 *   - 판정 못 함 → 78. 0으로 끝내면 "판정 불가"가 "통과"로 읽힌다.
 */
export function exitCodeFor(verdict: RegressionVerdict): EvalExitCode {
  if (!verdict.evaluated) return EVAL_EXIT_CODES.NOT_MEASURABLE;
  return verdict.pass ? EVAL_EXIT_CODES.OK : EVAL_EXIT_CODES.REGRESSED;
}

/** 콘솔 요약 한 덩어리. CLI 두 개가 같은 문장을 쓰게 한다. */
export function formatVerdict(report: RetrievalReport): string {
  const lines: string[] = [
    `[eval:retrieval] ${report.date} — 케이스 ${String(report.config.caseCount)}건, ` +
      `limit=${String(report.config.limit)}, provider=${report.embedding.provider}` +
      `${report.embedding.trusted ? "" : " (신뢰 불가)"}`,
  ];
  for (const metric of RETRIEVAL_METRIC_KEYS) {
    lines.push(
      `  ${metric.padEnd(9)} ${report.metrics[metric].toFixed(4)}  (기준선 ${report.baselines[metric].toFixed(4)})`,
    );
  }
  for (const [kind, breakdown] of Object.entries(report.byQueryKind)) {
    lines.push(
      `  · ${kind.padEnd(12)} n=${String(breakdown.caseCount).padStart(3)}  ` +
        `recall@5=${breakdown["recall@5"].toFixed(4)}  mrr=${breakdown.mrr.toFixed(4)}` +
        (breakdown.ambiguousTieCount > 0
          ? `  ⚠️ 동점 모호 ${String(breakdown.ambiguousTieCount)}건`
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

/** `BaselinesFile` → 비교에 쓰는 지표 묶음. 호출부에서 `.retrieval`을 반복하지 않게 한다. */
export function retrievalBaselines(file: BaselinesFile): RetrievalMetrics {
  return file.retrieval;
}

/**
 * 이미 만들어진 리포트를 **현재 기준선**으로 다시 판정한다.
 *
 * 리포트 안에 박힌 `baselines` 사본이 아니라 `eval/baselines.json`을 새로 읽어 넣는 것이
 * 요점이다 — 사람이 기준선을 올린 뒤에는 과거 리포트도 새 선으로 읽혀야 한다.
 * 검색을 다시 돌리지 않으므로 회귀 가드 자체를 결정론적으로 재현·테스트할 수 있다.
 */
export function recheckReport(
  report: RetrievalReport,
  baselines: RetrievalMetrics,
): RetrievalReport {
  return {
    ...report,
    baselines,
    regression: evaluateRegression({
      metrics: report.metrics,
      baselines,
      trusted: report.embedding.trusted,
      caseCount: report.config.caseCount,
    }),
  };
}
