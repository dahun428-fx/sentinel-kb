/**
 * generator 설정 테스트. 출처: specs/03 §4·§6, T-011 F-A·F-C.
 */
import { describe, expect, it } from "vitest";

import { GENERATOR_DEFAULTS, readGeneratorConfig } from "./config.js";

describe("readGeneratorConfig — SIMILARITY_THRESHOLD", () => {
  it("미설정이면 기본값이다", () => {
    expect(readGeneratorConfig({}).similarityThreshold).toBe(
      GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD,
    );
  });

  it("설정한 소수를 그대로 읽는다", () => {
    expect(readGeneratorConfig({ SIMILARITY_THRESHOLD: "0.45" }).similarityThreshold).toBe(0.45);
  });

  /*
   * 원시 cosine은 **음수가 정상값**이다(T-011 F-C, 범위 −1..1).
   * `readPositiveInt` 같은 정수·양수 검사를 붙이면 설정한 값이 조용히 기본값으로 되돌아간다.
   */
  it("음수 임계값을 받아들인다 — 원시 cosine 범위는 −1..1이다", () => {
    expect(readGeneratorConfig({ SIMILARITY_THRESHOLD: "-0.2" }).similarityThreshold).toBe(-0.2);
  });

  it("0을 받아들인다", () => {
    expect(readGeneratorConfig({ SIMILARITY_THRESHOLD: "0" }).similarityThreshold).toBe(0);
  });

  it.each(["abc", "", "   ", "NaN"])("비수치(%s)는 기본값으로 되돌린다", (raw) => {
    expect(readGeneratorConfig({ SIMILARITY_THRESHOLD: raw }).similarityThreshold).toBe(
      GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD,
    );
  });

  it.each(["1.5", "-2", "42"])("cosine 범위 밖(%s)은 기본값으로 되돌린다", (raw) => {
    // 범위 밖 임계값은 게이트를 항상-통과/항상-차단으로 만든다 — 튜닝이 아니라 무력화다.
    expect(readGeneratorConfig({ SIMILARITY_THRESHOLD: raw }).similarityThreshold).toBe(
      GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD,
    );
  });
});

describe("readGeneratorConfig — ANSWER_MAX_TOKENS", () => {
  it("미설정이면 기본값이다", () => {
    expect(readGeneratorConfig({}).answerMaxTokens).toBe(GENERATOR_DEFAULTS.ANSWER_MAX_TOKENS);
  });

  it("양의 정수를 읽는다", () => {
    expect(readGeneratorConfig({ ANSWER_MAX_TOKENS: "512" }).answerMaxTokens).toBe(512);
  });

  it.each(["0", "-1", "1.5", "abc"])("양의 정수가 아니면(%s) 기본값이다", (raw) => {
    expect(readGeneratorConfig({ ANSWER_MAX_TOKENS: raw }).answerMaxTokens).toBe(
      GENERATOR_DEFAULTS.ANSWER_MAX_TOKENS,
    );
  });
});

describe("기본값 표", () => {
  it("SIMILARITY_THRESHOLD 기본값은 원시 cosine 척도의 값이다", () => {
    // 정규화 척도로 재해석하면 안 되는 값이다(T-011 F-A). 범위 안이어야 한다.
    expect(GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD).toBeGreaterThan(-1);
    expect(GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD).toBeLessThan(1);
  });
});
