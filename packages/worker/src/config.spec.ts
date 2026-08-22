import { describe, expect, it } from "vitest";

import { readEmbedJobMaxAttempts, readEmbedPollIntervalMs } from "./config.js";

/**
 * specs/03 §6은 튜닝 파라미터의 코드 하드코딩을 금지한다. 여기 기대값은 `.env.example`과
 * specs/03 §1-4에 적힌 **리터럴**이며, 구현 상수를 참조하지 않는다 — 상수를 참조하면
 * 기본값이 바뀌어도 테스트가 따라 움직여 드리프트를 잡지 못한다.
 */
describe("readEmbedJobMaxAttempts", () => {
  it("env가 없으면 specs/03 §1-4의 3으로 떨어진다", () => {
    expect(readEmbedJobMaxAttempts({})).toBe(3);
  });

  it("env 값을 그대로 쓴다", () => {
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "7" })).toBe(7);
  });

  it("비수치·0 이하·빈 문자열은 기본값으로 떨어진다", () => {
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "  " })).toBe(3);
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "0" })).toBe(3);
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "-1" })).toBe(3);
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "세 번" })).toBe(3);
    expect(readEmbedJobMaxAttempts({ EMBED_JOB_MAX_ATTEMPTS: "2.5" })).toBe(3);
  });
});

describe("readEmbedPollIntervalMs", () => {
  it("env가 없으면 1000ms로 떨어진다", () => {
    expect(readEmbedPollIntervalMs({})).toBe(1000);
  });

  it("env 값을 그대로 쓴다", () => {
    expect(readEmbedPollIntervalMs({ EMBED_POLL_INTERVAL_MS: "50" })).toBe(50);
  });
});
