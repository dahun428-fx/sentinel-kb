/**
 * env 파싱 계약. specs/03 §6("튜닝 파라미터 전부 env, 하드코딩 금지")과
 * NFR-06("임베딩 모델 교체 가능")이 요구하는 실패 모드를 잠근다.
 */
import { describe, expect, it } from "vitest";

import { MAX_EMBEDDING_BATCH_SIZE, readEmbedderConfig } from "./config.js";
import { EMBEDDER_ERROR_CODES, EmbedderError } from "./types.js";

const FULL_ENV: NodeJS.ProcessEnv = {
  EMBEDDING_PROVIDER: "voyage",
  EMBEDDING_MODEL: "model-from-env",
  EMBEDDING_DIM: "8",
  EMBEDDING_VERSION: "2",
  VOYAGE_API_KEY: "key-from-env",
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmbedderError);
    return (error as EmbedderError).code;
  }
  throw new Error("에러가 던져지지 않았다");
}

describe("readEmbedderConfig", () => {
  it("env 값을 그대로 읽는다", () => {
    expect(readEmbedderConfig(FULL_ENV)).toEqual({
      provider: "voyage",
      dim: 8,
      version: 2,
      batchSize: 32,
    });
  });

  it("배치 크기 상한은 32다 (specs/03 §1-3)", () => {
    expect(MAX_EMBEDDING_BATCH_SIZE).toBe(32);
  });

  it("EMBEDDING_BATCH_SIZE 미설정·비수치·0 이하는 상한값으로 떨어진다", () => {
    for (const raw of ["", "  ", "abc", "0", "-4", "2.5"]) {
      expect(readEmbedderConfig({ ...FULL_ENV, EMBEDDING_BATCH_SIZE: raw }).batchSize).toBe(32);
    }
  });

  it("provider가 없거나 지원 목록 밖이면 PROVIDER_UNKNOWN", () => {
    expect(codeOf(() => readEmbedderConfig({ ...FULL_ENV, EMBEDDING_PROVIDER: "" }))).toBe(
      EMBEDDER_ERROR_CODES.PROVIDER_UNKNOWN,
    );
    expect(codeOf(() => readEmbedderConfig({ ...FULL_ENV, EMBEDDING_PROVIDER: "openai" }))).toBe(
      EMBEDDER_ERROR_CODES.PROVIDER_UNKNOWN,
    );
  });

  it("EMBEDDING_DIM은 기본값 없이 필수다 — 모델이 정하는 값이라 폴백이 위험하다", () => {
    for (const raw of ["", "0", "-1", "1.5", "abc"]) {
      expect(codeOf(() => readEmbedderConfig({ ...FULL_ENV, EMBEDDING_DIM: raw }))).toBe(
        EMBEDDER_ERROR_CODES.DIM_INVALID,
      );
    }
  });

  it("EMBEDDING_VERSION도 기본값 없이 필수다 (specs/02 마이그레이션 규칙)", () => {
    for (const raw of ["", "0", "-2", "1.1", "v1"]) {
      expect(codeOf(() => readEmbedderConfig({ ...FULL_ENV, EMBEDDING_VERSION: raw }))).toBe(
        EMBEDDER_ERROR_CODES.VERSION_INVALID,
      );
    }
  });
});
