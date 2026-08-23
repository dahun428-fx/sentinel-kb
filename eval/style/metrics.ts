/**
 * §6의 지표 계산. **순수 함수다** — 모델도 fs도 부르지 않는다.
 *
 * ## 판별 정확도는 낮을수록 좋다 — 그래서 낮게 만드는 **부정한 방법**을 전부 막아야 한다
 *
 * §6: "판별 정확도가 낮을수록 좋음(목표: 우연 수준 근접)". 지표가 낮을수록 좋으면
 * 지표를 낮추는 싸구려 경로가 곧 굿하트 표면이 된다. 셋이 있고 셋 다 여기서 관측된다.
 *
 * 1. **판별 못 하는 judge를 붙인다** → `controlAccuracy`. 대조군(누가 봐도 AI가 쓴 글)을
 *    놓치는 judge의 낮은 정확도는 아티클의 품질이 아니라 계기의 고장이다.
 * 2. **한쪽으로만 답하는 judge를 붙인다** → `degenerate`. 전부 "human"이라고 답하면
 *    사람 글은 다 맞고 아티클은 다 틀려 정확도가 humanShare로 내려앉는다. 그 숫자는
 *    문체를 잰 것이 아니다. 한 종류의 답만 나오면 그 실행은 판정 불가다(`guard.ts`).
 * 3. **사람 글을 지어낸다** → 코퍼스 쪽에서 막는다(`corpus.ts` HUMAN_SOURCES).
 *
 * 그래서 `chanceLevel`(다수 클래스 비율)을 함께 싣는다. 정확도 0.5가 "우연 수준"인 것은
 * 두 클래스가 균형일 때뿐이고, 균형이 아니면 우연 수준은 0.5가 아니다.
 */
import type { StyleOrigin } from "./corpus.js";
import type { StyleVerdict } from "./judge.js";

/** 판정이 끝난 글 한 편. `origin`은 판정 **뒤에** 다시 붙인 것이다(`blind.ts`). */
export interface JudgedPiece {
  readonly itemId: string;
  readonly origin: StyleOrigin;
  readonly sourceRef: string;
  readonly verdict: StyleVerdict;
  readonly confidence: number;
  readonly reason: string;
  readonly chars: number;
}

/** 아티클 1건에 대한 파이프라인(T-031)의 결정론적 산출. judge에게는 넘어가지 않는다. */
export interface PipelineOutcome {
  readonly articleId: string;
  readonly accepted: boolean;
  /** `DraftRejectionReason` 또는 null. */
  readonly rejection: string | null;
  /** 모델을 부르지 않았으면 `null` — "위반이 없었다"가 아니다(T-031 draft.ts의 그 구분). */
  readonly lintPassed: boolean | null;
  readonly lintViolationRules: readonly string[];
  /** 린트 단계에서 끝났으면 `null`. 0과 다르다. */
  readonly factCheckViolations: number | null;
  readonly attempts: number;
  /** §0-4 스타일 표본 수. 0이면 "문체가 나쁜가"가 아니라 "표본이 없었나"다(T-031 F-8). */
  readonly styleSamples: number;
}

export interface StyleMetrics {
  /** §6의 주 지표. generated + human에 대한 정답률. **낮을수록 좋다.** */
  readonly discriminationAccuracy: number;
  /** 같은 집합에서 다수 클래스가 차지하는 비율 = 아무렇게나 찍어도 나오는 값. */
  readonly chanceLevel: number;
  /** 생성 아티클을 "ai"라고 부른 비율. */
  readonly aiDetectionRate: number;
  /** 사람 글을 "ai"라고 부른 비율(오탐). */
  readonly humanFalseAiRate: number;
  /** 대조군을 "ai"라고 부른 비율. **계기 교정값이다**(Acceptance 2). */
  readonly controlAccuracy: number;
  /** 모델을 부른 아티클 중 린트를 통과한 비율(§6). judge와 무관하게 결정론적으로 잰다. */
  readonly lintPassRate: number;
  /** 팩트 대조 위반 총 건수(§6). 목표는 0이다. */
  readonly factCheckViolations: number;
  /**
   * 발행률(§6). **`null`은 0이 아니라 "재지 못했다"이다.** 아티클을 저장·발행하는 경로가
   * 아직 없어서(T-031 F-5) 후보 대비 발행 비율을 셀 모수가 존재하지 않는다.
   */
  readonly publicationRate: number | null;
  /** judge가 모든 글에 같은 답을 냈는가. 참이면 이 실행의 정확도는 문체의 함수가 아니다. */
  readonly degenerate: boolean;
}

export interface MetricsInput {
  readonly judged: readonly JudgedPiece[];
  readonly pipeline: readonly PipelineOutcome[];
  readonly publicationRate: number | null;
}

/** 이 글에 대한 판정이 맞았는가. 대조군의 정답은 "ai"다. */
export function isCorrect(piece: JudgedPiece): boolean {
  return piece.origin === "human" ? piece.verdict === "human" : piece.verdict === "ai";
}

export function computeStyleMetrics(input: MetricsInput): StyleMetrics {
  const { judged, pipeline } = input;
  const generated = judged.filter((piece) => piece.origin === "generated");
  const human = judged.filter((piece) => piece.origin === "human");
  const control = judged.filter((piece) => piece.origin === "control");
  const blindSet = [...generated, ...human];

  const withLint = pipeline.filter((entry) => entry.lintPassed !== null);
  const lintPassed = withLint.filter((entry) => entry.lintPassed === true);

  return {
    discriminationAccuracy: ratio(blindSet.filter(isCorrect).length, blindSet.length),
    chanceLevel: ratio(Math.max(generated.length, human.length), blindSet.length),
    aiDetectionRate: ratio(generated.filter((piece) => piece.verdict === "ai").length, generated.length),
    humanFalseAiRate: ratio(human.filter((piece) => piece.verdict === "ai").length, human.length),
    controlAccuracy: ratio(control.filter((piece) => piece.verdict === "ai").length, control.length),
    lintPassRate: ratio(lintPassed.length, withLint.length),
    factCheckViolations: pipeline.reduce((sum, entry) => sum + (entry.factCheckViolations ?? 0), 0),
    publicationRate: input.publicationRate,
    degenerate: isDegenerate(judged),
  };
}

/**
 * 모든 판정이 같은 값인가. 글이 2편 미만이면 "한쪽으로만 답했다"고 말할 수 없으므로
 * 판단하지 않는다(그 경우는 코퍼스 크기 게이트가 따로 막는다).
 */
export function isDegenerate(judged: readonly JudgedPiece[]): boolean {
  if (judged.length < 2) return false;
  const first = judged[0]?.verdict;
  return judged.every((piece) => piece.verdict === first);
}

/** 분모가 0이면 **0**이다. 1로 접으면 "잰 것이 없음"이 "완벽함"으로 읽힌다. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}
