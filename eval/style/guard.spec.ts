/**
 * 판정과 종료 코드. **여기서 죽여야 하는 뮤테이션이 다섯이다**:
 *   - judge가 항상 "사람 글"을 반환 → degenerate·대조군 게이트가 잡는다
 *   - 대조군 판별 실패를 성공으로 처리 → 대조군 게이트 (Acceptance 2)
 *   - 자격증명 없이(=fixture judge로) 판정 → trusted 게이트
 *   - 사람 글이 3편이 아닌데 판정 → 코퍼스 게이트
 *   - 기준선을 넘겼는데 exit 0 → `exitCodeForStyle`
 *
 * 단언에는 **측정 대상 상수를 쓰지 않는다**(T-031 F-7). `CONTROL_MIN_ACCURACY`를 올려도
 * 테스트가 따라 올라가면 그 상수를 재는 테스트가 사라진다 — 리터럴로 못박고 상수 자체를
 * 따로 단언한다.
 */
import { describe, expect, it } from "vitest";

import { CONTROL_MIN_ACCURACY, evaluateStyle, exitCodeForStyle, type StyleVerdictInput } from "./guard.js";
import type { StyleMetrics } from "./metrics.js";

function metrics(overrides: Partial<StyleMetrics> = {}): StyleMetrics {
  return {
    discriminationAccuracy: 0.5,
    chanceLevel: 0.5,
    aiDetectionRate: 0.5,
    humanFalseAiRate: 0.5,
    controlAccuracy: 1,
    lintPassRate: 1,
    factCheckViolations: 0,
    publicationRate: null,
    degenerate: false,
    ...overrides,
  };
}

function input(overrides: Partial<StyleVerdictInput> = {}): StyleVerdictInput {
  return {
    metrics: metrics(),
    generatedCount: 2,
    humanCount: 3,
    controlCount: 4,
    judgeTrusted: true,
    baseline: 0.7,
    ...overrides,
  };
}

describe("evaluateStyle — 판정 불가와 실패를 가른다", () => {
  it("fixture judge로는 판정하지 않는다", () => {
    const verdict = evaluateStyle(input({ judgeTrusted: false }));

    expect(verdict.evaluated).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("fixture");
  });

  it("생성 아티클이 0건이면 판정하지 않는다", () => {
    const verdict = evaluateStyle(input({ generatedCount: 0 }));

    expect(verdict.evaluated).toBe(false);
    expect(verdict.reason).toContain("0건");
  });

  it("사람 글이 3편 미만이면 판정하지 않는다 (specs/08 §6)", () => {
    const verdict = evaluateStyle(input({ humanCount: 1 }));

    expect(verdict.evaluated).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("3편");
  });

  it("대조군이 0편이면 판정하지 않는다", () => {
    const verdict = evaluateStyle(input({ controlCount: 0 }));

    expect(verdict.evaluated).toBe(false);
  });

  // ---------------------------------------------------------- Acceptance 2
  it("대조군을 놓치면 판정 불가다 — 낮은 판별 정확도가 성적으로 읽히면 안 된다", () => {
    const verdict = evaluateStyle(
      input({ metrics: metrics({ controlAccuracy: 0.5, discriminationAccuracy: 0.25 }) }),
    );

    expect(verdict.evaluated).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("대조군");
    expect(exitCodeForStyle(verdict)).toBe(78);
  });

  it("대조군 4편 중 3편만 맞히면(0.75) 아직 부족하다", () => {
    const verdict = evaluateStyle(input({ metrics: metrics({ controlAccuracy: 0.75 }) }));

    expect(verdict.evaluated).toBe(false);
  });

  it("대조군 하한은 0.9다", () => {
    // 상수를 단언 안에서 재사용하면 상수를 재는 테스트가 사라진다(T-031 F-7).
    expect(CONTROL_MIN_ACCURACY).toBe(0.9);
  });

  it("judge가 모든 글에 같은 답을 내면 판정 불가다", () => {
    const verdict = evaluateStyle(
      input({ metrics: metrics({ degenerate: true, discriminationAccuracy: 0.375 }) }),
    );

    expect(verdict.evaluated).toBe(false);
    expect(verdict.reason).toContain("같은 판정");
  });

  it("판별 정확도가 상한을 넘으면 실패다 (판정은 했다)", () => {
    const verdict = evaluateStyle(input({ metrics: metrics({ discriminationAccuracy: 0.9 }) }));

    expect(verdict.evaluated).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("0.9000");
  });

  it("상한과 같으면 통과다 — 상한은 '넘으면 안 되는 선'이다", () => {
    const verdict = evaluateStyle(input({ metrics: metrics({ discriminationAccuracy: 0.7 }) }));

    expect(verdict.evaluated).toBe(true);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it("상한보다 낮으면 통과다 — 낮을수록 좋은 지표다", () => {
    const verdict = evaluateStyle(input({ metrics: metrics({ discriminationAccuracy: 0.5 }) }));

    expect(verdict.pass).toBe(true);
  });

  it("게이트는 바깥에서 안으로 — 사람 글이 모자라면 정확도가 아무리 낮아도 통과가 아니다", () => {
    const verdict = evaluateStyle(
      input({ humanCount: 1, metrics: metrics({ discriminationAccuracy: 0 }) }),
    );

    expect(verdict.pass).toBe(false);
  });
});

describe("exitCodeForStyle", () => {
  it("통과는 0", () => {
    expect(exitCodeForStyle({ evaluated: true, pass: true, reason: null })).toBe(0);
  });

  it("기준선 하락은 1 — 0으로 끝내면 CI가 아무것도 막지 못한다", () => {
    expect(exitCodeForStyle({ evaluated: true, pass: false, reason: "넘었다" })).toBe(1);
  });

  it("판정 불가는 78 — 통과(0)로 접지 않는다", () => {
    expect(exitCodeForStyle({ evaluated: false, pass: false, reason: "못 쟀다" })).toBe(78);
  });
});
