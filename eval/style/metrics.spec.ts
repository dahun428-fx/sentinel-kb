/**
 * 지표 계산. **판별 정확도는 낮을수록 좋은 지표**라, 낮게 만드는 부정한 경로가 관측되는지가
 * 이 파일의 관심사다(`metrics.ts` 서두의 셋).
 */
import { describe, expect, it } from "vitest";

import type { StyleOrigin } from "./corpus.js";
import type { StyleVerdict } from "./judge.js";
import {
  computeStyleMetrics,
  isCorrect,
  isDegenerate,
  ratio,
  type JudgedPiece,
  type PipelineOutcome,
} from "./metrics.js";

function judged(origin: StyleOrigin, verdict: StyleVerdict, index = 1): JudgedPiece {
  return {
    itemId: `ITEM-0${String(index)}`,
    origin,
    sourceRef: `${origin}-${String(index)}`,
    verdict,
    confidence: 3,
    reason: "근거 한 줄",
    chars: 100,
  };
}

function outcome(overrides: Partial<PipelineOutcome> = {}): PipelineOutcome {
  return {
    articleId: "ART-pattern-01",
    accepted: true,
    rejection: null,
    lintPassed: true,
    lintViolationRules: [],
    factCheckViolations: 0,
    attempts: 1,
    styleSamples: 1,
    ...overrides,
  };
}

describe("isCorrect", () => {
  it("생성 아티클의 정답은 ai다", () => {
    expect(isCorrect(judged("generated", "ai"))).toBe(true);
    expect(isCorrect(judged("generated", "human"))).toBe(false);
  });

  it("사람 글의 정답은 human이다", () => {
    expect(isCorrect(judged("human", "human"))).toBe(true);
    expect(isCorrect(judged("human", "ai"))).toBe(false);
  });

  it("대조군의 정답도 ai다 — 의도적으로 상투 표현을 넣은 글이기 때문이다", () => {
    expect(isCorrect(judged("control", "ai"))).toBe(true);
    expect(isCorrect(judged("control", "human"))).toBe(false);
  });
});

describe("computeStyleMetrics", () => {
  it("판별 정확도는 생성분과 사람 글만 센다 — 대조군은 계기 교정용이라 섞지 않는다", () => {
    const metrics = computeStyleMetrics({
      judged: [
        judged("generated", "ai", 1),
        judged("generated", "human", 2),
        judged("human", "human", 3),
        judged("human", "human", 4),
        // 대조군을 전부 맞혀도 위 4편의 정확도(0.75)는 움직이지 않아야 한다.
        judged("control", "ai", 5),
        judged("control", "ai", 6),
      ],
      pipeline: [outcome()],
      publicationRate: null,
    });

    expect(metrics.discriminationAccuracy).toBe(0.75);
    expect(metrics.controlAccuracy).toBe(1);
  });

  it("대조군 정확도를 따로 낸다 — 이 값이 낮으면 낮은 판별 정확도는 성적이 아니라 고장이다", () => {
    const metrics = computeStyleMetrics({
      judged: [
        judged("generated", "human", 1),
        judged("human", "human", 2),
        judged("control", "human", 3),
        judged("control", "ai", 4),
      ],
      pipeline: [outcome()],
      publicationRate: null,
    });

    expect(metrics.controlAccuracy).toBe(0.5);
  });

  it("우연 수준을 함께 낸다 — 클래스가 불균형이면 0.5가 우연 수준이 아니다", () => {
    const metrics = computeStyleMetrics({
      judged: [
        judged("generated", "ai", 1),
        judged("human", "human", 2),
        judged("human", "human", 3),
        judged("human", "human", 4),
      ],
      pipeline: [outcome()],
      publicationRate: null,
    });

    expect(metrics.chanceLevel).toBe(0.75);
  });

  it("클래스별 비율을 갈라 낸다", () => {
    const metrics = computeStyleMetrics({
      judged: [
        judged("generated", "ai", 1),
        judged("generated", "ai", 2),
        judged("human", "ai", 3),
        judged("human", "human", 4),
      ],
      pipeline: [outcome()],
      publicationRate: null,
    });

    expect(metrics.aiDetectionRate).toBe(1);
    expect(metrics.humanFalseAiRate).toBe(0.5);
  });

  it("전부 같은 판정이면 degenerate다 — 그 정확도는 클래스 비율의 함수일 뿐이다", () => {
    const metrics = computeStyleMetrics({
      judged: [
        judged("generated", "human", 1),
        judged("human", "human", 2),
        judged("control", "human", 3),
      ],
      pipeline: [outcome()],
      publicationRate: null,
    });

    expect(metrics.degenerate).toBe(true);
    // 전부 "human"이면 사람 글만 맞아 정확도가 **낮게** 나온다. 이 낮은 값이 좋은 성적으로
    // 읽히면 안 된다는 것이 degenerate 플래그의 존재 이유다.
    expect(metrics.discriminationAccuracy).toBe(0.5);
  });

  it("린트 통과율은 모델을 부른 아티클만 분모로 센다", () => {
    const metrics = computeStyleMetrics({
      judged: [],
      pipeline: [
        outcome({ articleId: "A", lintPassed: true }),
        outcome({ articleId: "B", lintPassed: false }),
        // 모델을 부르지 않은 건(no-narrative)은 린트를 한 적이 없다.
        outcome({ articleId: "C", lintPassed: null, factCheckViolations: null }),
      ],
      publicationRate: null,
    });

    expect(metrics.lintPassRate).toBe(0.5);
  });

  it("팩트 대조 위반은 합산하고, 재지 못한 건(null)은 0으로 세지 않는다", () => {
    const metrics = computeStyleMetrics({
      judged: [],
      pipeline: [
        outcome({ articleId: "A", factCheckViolations: 2 }),
        outcome({ articleId: "B", factCheckViolations: null }),
      ],
      publicationRate: null,
    });

    expect(metrics.factCheckViolations).toBe(2);
  });

  it("발행률은 재지 못하면 null이다 — 0이 아니다", () => {
    const metrics = computeStyleMetrics({ judged: [], pipeline: [], publicationRate: null });

    expect(metrics.publicationRate).toBeNull();
  });
});

describe("ratio", () => {
  it("분모가 0이면 0이다 — 1로 접으면 '잰 것이 없음'이 '완벽함'으로 읽힌다", () => {
    expect(ratio(0, 0)).toBe(0);
  });

  it("소수 4자리로 반올림한다", () => {
    expect(ratio(1, 3)).toBe(0.3333);
  });
});

describe("isDegenerate", () => {
  it("글이 1편이면 판단하지 않는다", () => {
    expect(isDegenerate([judged("generated", "ai")])).toBe(false);
  });

  it("판정이 갈리면 false다", () => {
    expect(isDegenerate([judged("generated", "ai", 1), judged("human", "human", 2)])).toBe(false);
  });
});
