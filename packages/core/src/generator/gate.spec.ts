/**
 * 임계값 게이트 단위 테스트. 출처: specs/03 §4, 감사 B-1, T-011 F-A·F-B·F-C.
 */
import { describe, expect, it } from "vitest";

import { GENERATOR_DEFAULTS } from "./config.js";
import { GATE_OUTCOMES, evaluateThresholdGate } from "./gate.js";

const THRESHOLD = GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD;

describe("evaluateThresholdGate", () => {
  it("원시 cosine 최고점이 임계값 이상이면 통과한다", () => {
    const decision = evaluateThresholdGate(0.7, THRESHOLD);
    expect(decision.passed).toBe(true);
    expect(decision.outcome).toBe(GATE_OUTCOMES.ABOVE_THRESHOLD);
    expect(decision.thresholdEvaluated).toBe(true);
  });

  it("임계값 미만이면 차단한다", () => {
    const decision = evaluateThresholdGate(0.61, THRESHOLD);
    expect(decision.passed).toBe(false);
    expect(decision.outcome).toBe(GATE_OUTCOMES.BELOW_THRESHOLD);
    expect(decision.thresholdEvaluated).toBe(true);
  });

  it("경계값은 통과다 — 스펙 문면이 '미만이면 스킵'이다", () => {
    expect(evaluateThresholdGate(THRESHOLD, THRESHOLD).passed).toBe(true);
  });

  /*
   * 뮤테이션 방어: 이미 원시 cosine으로 환산된 값을 여기서 `2s − 1`로 한 번 더 접는 실수.
   * 0.62 <= s < 0.81 구간이 그 실수를 드러낸다 — 이중 환산하면 2*0.7-1 = 0.4가 되어 차단된다.
   * (T-011 F-A: retriever가 이미 환산해서 준다.)
   */
  it.each([0.62, 0.65, 0.7, 0.8])("이미 환산된 값(%s)을 다시 환산하지 않는다", (score) => {
    expect(evaluateThresholdGate(score, THRESHOLD).passed).toBe(true);
  });

  /*
   * 뮤테이션 방어: RRF 점수(`Σ 1/(k+rank)`, k=60이면 최대 약 0.033)로 비교하는 실수.
   * 그 척도의 값은 전부 임계값 미만이라 시스템이 영원히 found:false가 된다(시드 SELF-01).
   * 게이트 함수가 숫자 하나만 받으므로 여기서는 "그 크기의 값은 차단된다"만 못박는다 —
   * 척도를 잘못 넘기는 것 자체는 `generate.spec.ts`가 잡는다.
   */
  it("RRF 척도 크기의 값(0.033)은 임계값 미만이다", () => {
    expect(evaluateThresholdGate(0.033, THRESHOLD).passed).toBe(false);
  });

  describe("maxVectorScore === null (T-011 F-B 결정)", () => {
    it("통과시킨다 — 텍스트 경로 hit도 인용 가능한 근거다", () => {
      expect(evaluateThresholdGate(null, THRESHOLD).passed).toBe(true);
    });

    it("판정하지 못했다는 사실을 남긴다 — 조용히 통과시키지 않는다", () => {
      const decision = evaluateThresholdGate(null, THRESHOLD);
      expect(decision.thresholdEvaluated).toBe(false);
      expect(decision.outcome).toBe(GATE_OUTCOMES.NOT_EVALUABLE);
      expect(decision.maxVectorScore).toBeNull();
    });

    it("정상 통과와 구별된다 — T-013이 스윕에서 이 케이스를 분리해야 한다", () => {
      const evaluated = evaluateThresholdGate(0.9, THRESHOLD);
      const notEvaluable = evaluateThresholdGate(null, THRESHOLD);
      expect(evaluated.passed).toBe(notEvaluable.passed);
      expect(evaluated.outcome).not.toBe(notEvaluable.outcome);
      expect(evaluated.thresholdEvaluated).not.toBe(notEvaluable.thresholdEvaluated);
    });

    /*
     * 뮤테이션 방어: `Number(null) = 0`으로 접어 차단하는 실수.
     * 그렇게 하면 "판정 불가"가 "유사도 0"으로 오판되고, 값이 0일 때와 구별되지 않는다.
     */
    it("0과 다르게 다뤄진다 — 유사도 0과 판정 불가는 다르다", () => {
      const zero = evaluateThresholdGate(0, THRESHOLD);
      const nullish = evaluateThresholdGate(null, THRESHOLD);
      expect(zero.passed).toBe(false);
      expect(nullish.passed).toBe(true);
    });
  });

  describe("음수 (T-011 F-C: 원시 cosine 범위는 −1..1)", () => {
    it("음수는 정상값이며 임계값 미만으로 차단된다", () => {
      const decision = evaluateThresholdGate(-0.5, THRESHOLD);
      expect(decision.passed).toBe(false);
      expect(decision.thresholdEvaluated).toBe(true);
      expect(decision.maxVectorScore).toBe(-0.5);
    });

    /* null 체크와 음수 체크를 섞으면(예: `!maxVectorScore`) −0.5가 판정 불가로 새어 통과한다. */
    it("음수를 '판정 불가'로 오분류하지 않는다", () => {
      expect(evaluateThresholdGate(-1, THRESHOLD).outcome).toBe(GATE_OUTCOMES.BELOW_THRESHOLD);
      expect(evaluateThresholdGate(-0.000001, THRESHOLD).thresholdEvaluated).toBe(true);
    });

    /* `0`도 falsy다 — 같은 실수가 0에서도 새는지 확인한다. */
    it("0을 '판정 불가'로 오분류하지 않는다", () => {
      expect(evaluateThresholdGate(0, THRESHOLD).thresholdEvaluated).toBe(true);
    });
  });

  it("비교에 쓴 임계값을 결과에 싣는다 — 어느 설정으로 잰 값인지 되짚을 수 있어야 한다", () => {
    expect(evaluateThresholdGate(0.5, 0.4).threshold).toBe(0.4);
    expect(evaluateThresholdGate(null, 0.4).threshold).toBe(0.4);
  });
});
