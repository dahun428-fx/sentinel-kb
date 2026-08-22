/**
 * retriever 파라미터가 **env에서** 온다는 것을 잠근다 (specs/03 §6).
 */
import { describe, expect, it } from "vitest";

import { RETRIEVAL_DEFAULTS, readRetrievalConfig } from "./config.js";

describe("readRetrievalConfig", () => {
  it("env 값을 그대로 읽는다", () => {
    const config = readRetrievalConfig({
      RETRIEVAL_VECTOR_K: "7",
      RETRIEVAL_TEXT_K: "9",
      RETRIEVAL_FINAL_K: "3",
      RRF_K: "11",
      RETRIEVAL_NUM_CANDIDATES: "999",
      RETRIEVAL_CANDIDATE_OVERFETCH: "5",
      RETRIEVAL_MAX_CHUNKS_PER_RECORD: "1",
    });

    expect(config).toEqual({
      vectorK: 7,
      textK: 9,
      finalK: 3,
      rrfK: 11,
      numCandidates: 999,
      candidateOverfetch: 5,
      maxChunksPerRecord: 1,
    });
  });

  it("미설정이면 .env.example과 같은 기본값이다", () => {
    const config = readRetrievalConfig({});

    expect(config.vectorK).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_VECTOR_K);
    expect(config.textK).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_TEXT_K);
    expect(config.finalK).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_FINAL_K);
    expect(config.rrfK).toBe(RETRIEVAL_DEFAULTS.RRF_K);
    expect(config.numCandidates).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_NUM_CANDIDATES);
    expect(config.candidateOverfetch).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_CANDIDATE_OVERFETCH);
    expect(config.maxChunksPerRecord).toBe(RETRIEVAL_DEFAULTS.RETRIEVAL_MAX_CHUNKS_PER_RECORD);
  });

  it("오설정은 던지지 않고 기본값으로 되돌린다", () => {
    for (const bad of ["0", "-3", "abc", "1.5", " ", ""]) {
      const config = readRetrievalConfig({ RETRIEVAL_FINAL_K: bad });
      expect(config.finalK, `RETRIEVAL_FINAL_K=${JSON.stringify(bad)}`).toBe(
        RETRIEVAL_DEFAULTS.RETRIEVAL_FINAL_K,
      );
    }
  });

  /**
   * Atlas는 `numCandidates >= limit`를 요구한다. overfetch를 키운 채 numCandidates를
   * 그대로 두면 쿼리가 통째로 죽으므로 설정 단계에서 끌어올린다.
   */
  it("numCandidates가 후보 limit보다 작으면 끌어올린다", () => {
    const config = readRetrievalConfig({
      RETRIEVAL_VECTOR_K: "50",
      RETRIEVAL_CANDIDATE_OVERFETCH: "4",
      RETRIEVAL_NUM_CANDIDATES: "10",
    });

    expect(config.numCandidates).toBe(200);
  });

  it("기본값 표가 .env.example의 값과 같다", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
      "utf8",
    );

    for (const [name, value] of Object.entries(RETRIEVAL_DEFAULTS)) {
      // 문서와 코드가 갈라지면 eval 스윕 결과를 재현할 수 없다.
      expect(envExample, `${name}이 .env.example과 다르다`).toContain(
        `\n${name}=${String(value)}\n`,
      );
    }
  });
});
