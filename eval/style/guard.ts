/**
 * 판정과 종료 코드. `eval/injection/guard.ts`와 같은 규약이다:
 * **순수 판정**과 **종료 코드**를 나누고, 코드 상수는 retrieval에서 그대로 가져다 쓴다
 * (0 통과 / 1 하락 / 78 판정 불가). 러너마다 다른 코드를 쓰면 CI가 둘을 같이 못 읽는다.
 *
 * ## `evaluated`와 `pass`를 나누는 것이 이 파일의 존재 이유다
 *
 * 판별 정확도는 **낮을수록 좋은** 지표라 게이트가 없으면 고장이 성공으로 읽힌다:
 * judge를 못 세워도, 대조군을 다 놓쳐도, 한쪽으로만 답해도 정확도는 낮게 나온다.
 * 그 셋은 전부 `pass:false`가 아니라 `evaluated:false`다 — "AI 티가 없다"와
 * "재지 못했다"는 다른 사실이고, 후자를 전자로 접으면 자격증명 없이 돌린 CI가
 * **"우리 글은 사람 글과 구별되지 않는다"고 보고하기 시작한다.**
 *
 * 게이트 순서는 **바깥에서 안으로**다: 코퍼스가 성립하는가 → 계기가 작동하는가 → 수치가 기준선 안인가.
 */
import { EVAL_EXIT_CODES, type EvalExitCode } from "../retrieval/baseline-guard.js";

import { REQUIRED_HUMAN_PIECES } from "./corpus.js";
import type { StyleMetrics } from "./metrics.js";

/** 부동소수 꼬리 보정. `baseline-guard.ts`와 같은 값·같은 이유다. */
export const STYLE_EPSILON = 1e-9;

/**
 * 대조군 판별 정확도의 하한. Acceptance 2의 "**높은** 판별 정확도로 걸러짐"이 이 값이다.
 * 1.0이 아닌 이유는 대조군 1편의 일시적 흔들림으로 전체 실행이 판정 불가가 되는 것을
 * 피하기 위해서이고, 0.9인 이유는 현재 대조군 4편에서 그것이 실질적으로 "4편 중 4편"을
 * 뜻하기 때문이다(3/4 = 0.75 < 0.9). 대조군이 커지면 한 편의 여유가 생긴다.
 */
export const CONTROL_MIN_ACCURACY = 0.9;

export interface StyleVerdictInput {
  readonly metrics: StyleMetrics;
  readonly generatedCount: number;
  readonly humanCount: number;
  readonly controlCount: number;
  /** judge가 실제 모델인가. fixture면 이 리포트로 품질을 주장하지 않는다. */
  readonly judgeTrusted: boolean;
  /** `eval/baselines.json`의 상한. 판별 정확도가 이보다 **높으면** 실패다. */
  readonly baseline: number;
}

export interface StyleRegressionVerdict {
  readonly evaluated: boolean;
  readonly pass: boolean;
  readonly reason: string | null;
}

export function evaluateStyle(input: StyleVerdictInput): StyleRegressionVerdict {
  if (!input.judgeTrusted) {
    return notEvaluated(
      "judge가 실제 모델이 아니다(fixture). 고정 응답으로 낸 판별 정확도는 문체에 대해 " +
        "아무것도 말하지 않으므로 이 리포트로는 판정하지 않는다.",
    );
  }

  if (input.generatedCount === 0) {
    return notEvaluated(
      "생성 아티클이 0건이다. 잰 것이 없으므로 판정하지 않는다 — 0건을 '구별되지 않음'으로 " +
        "읽으면 아티클을 하나도 만들지 않는 것이 이 eval을 통과시키는 가장 쉬운 방법이 된다.",
    );
  }

  if (input.humanCount < REQUIRED_HUMAN_PIECES) {
    return notEvaluated(
      `사람 글이 ${String(input.humanCount)}편이다 — specs/08 §6은 3편을 요구한다. ` +
        "부족분을 지어내면 'AI가 쓴 사람 글 흉내'와 아티클을 비교하게 되고 낮은 판별 정확도가 " +
        "당연해진다. 채우는 것은 사람의 몫이다(eval/style/README.md).",
    );
  }

  if (input.controlCount === 0) {
    return notEvaluated(
      "대조군이 0편이다. 대조군 없이는 낮은 판별 정확도가 '아티클이 좋다'인지 " +
        "'judge가 판별을 못 한다'인지 가를 수 없다(Acceptance 2).",
    );
  }

  // 계기 교정. **여기가 Acceptance 2의 판정 지점이다.**
  if (input.metrics.controlAccuracy < CONTROL_MIN_ACCURACY - STYLE_EPSILON) {
    return notEvaluated(
      `대조군 판별 정확도가 ${input.metrics.controlAccuracy.toFixed(4)}로 하한 ` +
        `${CONTROL_MIN_ACCURACY.toFixed(4)} 아래다. 의도적으로 상투 표현을 넣은 글마저 놓치는 ` +
        "judge의 낮은 판별 정확도는 아티클의 성적이 아니라 계기의 고장이다.",
    );
  }

  if (input.metrics.degenerate) {
    return notEvaluated(
      "judge가 모든 글에 같은 판정을 냈다. 그 경우 판별 정확도는 클래스 비율의 함수일 뿐 " +
        "문체의 함수가 아니다.",
    );
  }

  const { discriminationAccuracy } = input.metrics;
  if (discriminationAccuracy > input.baseline + STYLE_EPSILON) {
    return {
      evaluated: true,
      pass: false,
      reason:
        `판별 정확도가 ${discriminationAccuracy.toFixed(4)}로 상한 ${input.baseline.toFixed(4)}을 넘었다 ` +
        `(우연 수준 ${input.metrics.chanceLevel.toFixed(4)}). judge가 생성 아티클을 사람 글과 ` +
        "구별해 내고 있다는 뜻이다(specs/08 §6).",
    };
  }

  return { evaluated: true, pass: true, reason: null };
}

/**
 * 판정 → 종료 코드. **판정 못 함을 0으로 끝내지 않는 것이 이 함수의 존재 이유다.**
 * 78을 0으로 접으면 자격증명 없이 돌린 CI가 "AI 티 없음"으로 읽힌다.
 */
export function exitCodeForStyle(verdict: StyleRegressionVerdict): EvalExitCode {
  if (!verdict.evaluated) return EVAL_EXIT_CODES.NOT_MEASURABLE;
  return verdict.pass ? EVAL_EXIT_CODES.OK : EVAL_EXIT_CODES.REGRESSED;
}

function notEvaluated(reason: string): StyleRegressionVerdict {
  return { evaluated: false, pass: false, reason };
}
