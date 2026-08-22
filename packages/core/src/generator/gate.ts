/**
 * 임계값 게이트. 출처: specs/03-rag-pipeline.md §4, NFR-02, 감사 B-1, T-011 F-A·F-B·F-C.
 *
 * ## 무엇과 비교하는가
 *
 * `RetrievalResult.maxVectorScore` — **융합·dedupe·slice 이전**의 벡터 후보 전체에 대한
 * **원시 cosine 최고점**이다. 이 값을 `SIMILARITY_THRESHOLD`와 **그대로** 비교한다.
 *
 *  - **RRF 점수(`fusedScore`)와 비교하지 않는다.** `specs/03:62`가 명시적으로 금지한다 —
 *    RRF는 `Σ 1/(k+rank)` 척도라 k=60이면 이론 최댓값이 약 0.033이고, 0.62와 비교하면
 *    모든 질의가 미달이 되어 시스템이 영원히 "사례 없음"만 반환한다(시드 SELF-01의 그 사고).
 *  - **다시 환산하지 않는다.** Atlas가 준 `(1+cos)/2`를 retriever가 이미 `2s − 1`로
 *    되돌려 놨다(T-011 F-A). 여기서 한 번 더 접으면 0.62가 실질 0.81 게이트가 된다.
 *
 * ## `maxVectorScore === null`일 때 (T-011 F-B, 인간 비준 대기 결정)
 *
 * `specs/03 §4`는 이 경우를 정하지 않았다. 벡터 경로가 0건이면 값은 `0`이 아니라 `null`이다 —
 * **"유사도 0"과 "판정 불가"는 다르다.** 그리고 그 상태에서 텍스트 경로 hit이 있는 상황이
 * 실재한다(T-011 검증자 재현: `vectorCandidateCount=0`, `textCandidateCount=1`, hits 1건).
 *
 * **결정: `null`이면 게이트를 통과시키되, 임계값을 판정하지 못했다는 사실을 남긴다.**
 *
 *  (a) 텍스트 경로 hit도 **인용 가능한 근거**다. `[REC-id#section]`을 만들 수 있으므로
 *      NFR-02("근거 없는 해결책 생성 금지")를 위반하지 않는다.
 *  (b) 막으면 유효한 결과를 버린다 — 검색은 됐는데 답을 안 하는 상태다.
 *  (c) `Number(null) = 0`으로 접어 차단하면 "유사도 0"으로 **오판**하는 것이고,
 *      그것이 감사 B-1이 막으려던 바로 그 종류의 단위 오류다.
 *
 * **조용히 통과시키지 않는다.** `thresholdEvaluated: false`가 결과와 로그 양쪽에 남아야
 * T-013이 임계값을 스윕할 때 이 케이스를 분리해 볼 수 있다. 판정하지 못한 통과를 판정한
 * 통과와 같은 칸에 넣으면 스윕 곡선이 오염된다.
 */

/** 게이트가 왜 그렇게 결정했는지. 로그·리포트가 케이스를 분리하는 키다. */
export const GATE_OUTCOMES = {
  /** 원시 cosine 최고점이 임계값 이상 — 정상 통과. */
  ABOVE_THRESHOLD: "above-threshold",
  /** 원시 cosine 최고점이 임계값 미만 — 생성 스킵. */
  BELOW_THRESHOLD: "below-threshold",
  /** 벡터 경로 0건이라 임계값을 판정할 수 없었다 — 통과시키되 표시한다. */
  NOT_EVALUABLE: "not-evaluable",
} as const;

export type GateOutcome = (typeof GATE_OUTCOMES)[keyof typeof GATE_OUTCOMES];

export interface GateDecision {
  /** 생성으로 넘어가도 되는가. `false`면 모델을 **부르지 않는다**. */
  readonly passed: boolean;
  readonly outcome: GateOutcome;
  /**
   * 임계값 비교가 실제로 일어났는가. `null` 통과와 정상 통과를 가르는 필드다.
   * **`passed`와 혼동하지 마라** — 판정 불가는 `passed: true, thresholdEvaluated: false`다.
   */
  readonly thresholdEvaluated: boolean;
  /** 비교에 쓰인 값(원시 cosine, −1..1). 판정 불가면 null. */
  readonly maxVectorScore: number | null;
  /** 비교 대상 임계값. 스윕 리포트가 어느 설정으로 잰 값인지 되짚는 근거다. */
  readonly threshold: number;
}

/**
 * 게이트를 판정한다. **입력은 `maxVectorScore` 하나뿐이다** — `hits`도 `fusedScore`도
 * 받지 않는다. 받지 않으면 잘못된 척도로 비교할 수가 없다.
 */
export function evaluateThresholdGate(
  maxVectorScore: number | null,
  threshold: number,
): GateDecision {
  // `null` 체크가 먼저다. 음수 체크와 섞지 마라 — 음수는 정상값이고(원시 cosine 범위 −1..1),
  // `null`은 판정 불가다 (T-011 F-C). `maxVectorScore < threshold`는 null에서 false를
  // 내지만 그건 우연이지 의도가 아니므로, 의도를 명시적으로 적는다.
  if (maxVectorScore === null) {
    return {
      passed: true,
      outcome: GATE_OUTCOMES.NOT_EVALUABLE,
      thresholdEvaluated: false,
      maxVectorScore: null,
      threshold,
    };
  }

  const passed = maxVectorScore >= threshold;
  return {
    passed,
    outcome: passed ? GATE_OUTCOMES.ABOVE_THRESHOLD : GATE_OUTCOMES.BELOW_THRESHOLD,
    thresholdEvaluated: true,
    maxVectorScore,
    threshold,
  };
}
