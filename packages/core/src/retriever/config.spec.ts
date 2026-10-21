/**
 * retriever 파라미터가 **env에서** 온다는 것을 잠근다 (specs/03 §6).
 */
import { describe, expect, it } from "vitest";

import {
  RELATION_EXPANSION_DEFAULT,
  RETRIEVAL_DEFAULTS,
  readRetrievalConfig,
} from "./config.js";

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
      relationExpansion: false,
    });
  });

  /**
   * T-035 / specs/03 §2.5: "on/off 플래그로 두고 eval에서 효과를 비교한다 —
   * **지표가 오르지 않으면 확장하지 않는다.**" 측정이 아직 없으므로(T-013 BLOCKED)
   * 기본은 off여야 한다. 이 단언이 "언제부터인가 기본이 on이 되어 있었다"를 막는 유일한 자리다.
   */
  describe("RELATION_EXPANSION (관계 확장 플래그)", () => {
    it("미설정이면 off다 — 측정되지 않은 확장은 켜지지 않는다", () => {
      expect(RELATION_EXPANSION_DEFAULT).toBe(false);
      expect(readRetrievalConfig({}).relationExpansion).toBe(false);
    });

    it("on 계열 값을 켠다", () => {
      for (const raw of ["on", "ON", " on ", "true", "1", "yes"]) {
        expect(readRetrievalConfig({ RELATION_EXPANSION: raw }).relationExpansion, raw).toBe(true);
      }
    });

    it("off 계열 값을 끈다", () => {
      for (const raw of ["off", "OFF", "false", "0", "no"]) {
        expect(readRetrievalConfig({ RELATION_EXPANSION: raw }).relationExpansion, raw).toBe(false);
      }
    });

    it("인식하지 못하는 값은 off로 되돌린다 — 오타로 확장이 켜지면 안 된다", () => {
      for (const raw of ["onn", "enabled", "", " ", "2", "maybe"]) {
        expect(readRetrievalConfig({ RELATION_EXPANSION: raw }).relationExpansion, raw).toBe(false);
      }
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

  /**
   * **기본값 표의 리터럴 계약 앵커** (T-043).
   *
   * 바로 위 "미설정이면 .env.example과 같은 기본값이다"는 `RETRIEVAL_DEFAULTS`를 **기대값으로**
   * 쓴다. 좌변인 `readRetrievalConfig({})`도 같은 표에서 나오므로, 표를 옮기면 좌우가 함께
   * 따라간다 — 자기충족이다. 아래 `.env.example` 거울 대조도 잠금이 아니다: 문서에는 사람
   * 승인 게이트가 없어 **상수와 문서를 같은 커밋에서 옮기는 것**이 게이트를 통과하는 가장 싼
   * 길이다. 실측(T-043): 여섯 파라미터의 현실적 드리프트 뮤턴트(200→150, 8→6, 20→15, 60→30,
   * 4→5, 2→4)를 `.env.example`과 **함께** 넣으면 유닛 스위트가 **전건 통과**했다.
   *
   * 그래서 값을 여기 리터럴로 박는다. 근거는 둘로 갈린다:
   * - `RETRIEVAL_NUM_CANDIDATES=200`·`RETRIEVAL_MAX_CHUNKS_PER_RECORD=2`는 specs/03 §2 문면.
   * - 나머지 다섯은 §6의 **스윕 대상**이다. 스윕은 env로 하므로(다음 테스트가 증명한다)
   *   이 앵커가 스윕을 막지 않는다. 잠그는 것은 **커밋된 기본값**이고, 그것을 옮기는 것은
   *   eval 재현성에 영향을 주는 결정이라 리뷰에 보여야 한다.
   */
  it("기본값 표가 리터럴과 같다 — 기본값 드리프트는 리뷰를 거쳐야 한다", () => {
    expect(RETRIEVAL_DEFAULTS).toEqual({
      RETRIEVAL_VECTOR_K: 20,
      RETRIEVAL_TEXT_K: 20,
      RETRIEVAL_FINAL_K: 8,
      RRF_K: 60,
      RETRIEVAL_NUM_CANDIDATES: 200,
      RETRIEVAL_CANDIDATE_OVERFETCH: 4,
      RETRIEVAL_MAX_CHUNKS_PER_RECORD: 2,
    });
  });

  it("앵커가 eval 스윕을 막지 않는다 — 스윕은 env로 한다 (specs/03 §6)", () => {
    // 위 앵커는 **커밋된 기본값**만 잠근다. 주입 경로가 막히면 T-013이 K·RRF_K를 흔들 수 없다.
    expect(
      readRetrievalConfig({
        RETRIEVAL_VECTOR_K: "40",
        RETRIEVAL_TEXT_K: "40",
        RETRIEVAL_FINAL_K: "12",
        RRF_K: "10",
        RETRIEVAL_NUM_CANDIDATES: "500",
        RETRIEVAL_CANDIDATE_OVERFETCH: "3",
        RETRIEVAL_MAX_CHUNKS_PER_RECORD: "5",
      }),
    ).toEqual({
      vectorK: 40,
      textK: 40,
      finalK: 12,
      rrfK: 10,
      numCandidates: 500,
      candidateOverfetch: 3,
      maxChunksPerRecord: 5,
      relationExpansion: false,
    });
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
