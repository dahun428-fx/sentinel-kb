/**
 * T-019 단위 테스트 — 순수 함수(로그 필드·인용 투영·SSE 프레이밍)만 본다.
 * 라우트 동작은 `answer.int.spec.ts`가 실제 HTTP 왕복으로 본다.
 */
import type { GenerateResult, RetrievalResult, RetrievedChunk } from "@sentinel/core";
import { describe, expect, it } from "vitest";

import {
  ANSWER_LOG_EVENT,
  ANSWER_ROUTE,
  buildAnswerLogFields,
  splitAnswerChunks,
  toAnswerBody,
  sseFrame,
  toCitation,
  toCitations,
} from "./answer.js";

const RECORD_ID = "68f0c4a1b2c3d4e5f6a7b8c9";
const OTHER_RECORD_ID = "68f0c4a1b2c3d4e5f6a7b8ca";

/**
 * `RetrievedChunk` 빌더. core의 `generator/fixtures.ts`와 같은 물건이지만 그쪽은 배럴에
 * export되지 않는다(프로덕션 표면이 아니라는 T-018의 판단) — 그 결정을 뒤집는 것은
 * `packages/core` 수정이라 이 태스크의 Context budget 밖이다. 여기서는 관심 필드만 덮는다.
 */
function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    recordId: RECORD_ID,
    section: "resolution",
    seq: 0,
    text: "커넥션 풀 상한을 20으로 올리고 애플리케이션을 재시작했다.",
    title: "커넥션 풀 고갈",
    summary: "요약",
    type: "incident",
    project: "sentinel-kb",
    flags: [],
    fusedScore: 0.032,
    vectorScore: 0.81,
    textScore: null,
    vectorRank: 0,
    textRank: null,
    ...overrides,
  };
}

function makeRetrieval(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  const hits = overrides.hits ?? [makeChunk()];
  return {
    hits,
    maxVectorScore: 0.81,
    vectorCandidateCount: hits.length,
    textCandidateCount: 0,
    ...overrides,
  };
}

describe("toCitation", () => {
  it("청크 본문(text)을 인용에 싣지 않는다 — NFR-03", () => {
    const chunk = makeChunk({ recordId: RECORD_ID, text: "본문이 여기 있으면 안 된다" });

    const citation = toCitation(chunk);

    expect(Object.keys(citation).sort()).toEqual(["recordId", "score", "section", "title"]);
    expect(JSON.stringify(citation)).not.toContain("본문이 여기 있으면 안 된다");
  });

  it("score는 fusedScore(RRF)다 — 항상 존재하는 유일한 점수이기 때문", () => {
    const chunk = makeChunk({ recordId: RECORD_ID, fusedScore: 0.016, vectorScore: null });

    expect(toCitation(chunk).score).toBe(0.016);
  });
});

describe("toCitations", () => {
  /**
   * **컨텍스트에 실제로 들어간 청크만 인용이 된다**(T-018 F-4).
   * `injection-suspect`로 제외된 청크는 `contextChunkIds`에 없으므로 여기서도 빠진다 —
   * 이 성질이 깨지면 T-018의 제외가 HTTP 표면에서 되살아난다.
   */
  it("contextChunkIds 밖의 hit은 인용에서 빠진다", () => {
    const kept = makeChunk({ chunkId: "kept", recordId: RECORD_ID });
    const excluded = makeChunk({
      chunkId: "tainted",
      recordId: OTHER_RECORD_ID,
      flags: ["injection-suspect"],
    });

    const citations = toCitations([kept, excluded], ["kept"]);

    expect(citations.map((citation) => citation.recordId)).toEqual([RECORD_ID]);
  });

  it("같은 record의 같은 섹션은 한 번만 인용한다", () => {
    const first = makeChunk({ chunkId: "a", recordId: RECORD_ID, section: "resolution" });
    const second = makeChunk({ chunkId: "b", recordId: RECORD_ID, section: "resolution" });

    expect(toCitations([first, second], ["a", "b"])).toHaveLength(1);
  });

  it("hits 순서(RRF 순위)를 그대로 유지한다", () => {
    const first = makeChunk({ chunkId: "a", recordId: RECORD_ID, section: "resolution" });
    const second = makeChunk({ chunkId: "b", recordId: OTHER_RECORD_ID, section: "symptom" });

    expect(toCitations([first, second], ["a", "b"]).map((c) => c.recordId)).toEqual([
      RECORD_ID,
      OTHER_RECORD_ID,
    ]);
  });
});

describe("toAnswerBody", () => {
  const FOUND: GenerateResult = {
    found: true,
    answer: "풀 상한을 올려라 [REC-x#resolution]",
    gate: {
      passed: true,
      outcome: "above-threshold",
      thresholdEvaluated: true,
      maxVectorScore: 0.81,
      threshold: 0.62,
    },
    citations: ["[REC-x#resolution]"],
    contextChunkIds: ["chunk-1"],
    excluded: [],
    model: "fake-chat-model",
  };

  /**
   * **근거 없는 답변은 계약에서 죽는다** (FR-04·NFR-02). `citations.min(1)`이 그 방어선이다.
   * 이 단언이 없으면 `.parse`를 지우는 변경이 아무 테스트도 깨뜨리지 않고 통과한다 —
   * 라우트 경로만으로는 이 상태에 도달할 수 없기 때문이다(생성기가 먼저 막는다).
   */
  it("인용이 0개인 found:true는 응답이 될 수 없다", () => {
    expect(() => toAnswerBody(FOUND, [])).toThrow();
  });

  it("인용이 있으면 그대로 응답이 된다", () => {
    const citation = toCitation(makeChunk());

    expect(toAnswerBody(FOUND, [citation])).toEqual({
      found: true,
      answer: FOUND.answer,
      citations: [citation],
    });
  });

  /** found:false는 언제나 `suggestRecord:true`다 — 계약이 `z.literal(true)`로 못박았다. */
  it("found:false는 suggestRecord:true를 달고 나간다", () => {
    expect(
      toAnswerBody(
        {
          found: false,
          suggestRecord: true,
          message: "유사 사례 없음",
          skipReason: "below-threshold",
          gate: {
            passed: false,
            outcome: "below-threshold",
            thresholdEvaluated: true,
            maxVectorScore: 0.1,
            threshold: 0.62,
          },
          excluded: [],
        },
        [],
      ),
    ).toEqual({ found: false, message: "유사 사례 없음", suggestRecord: true });
  });
});

describe("splitAnswerChunks", () => {
  it("답변을 이어 붙이면 원문과 같다", () => {
    const answer = "가".repeat(500);

    expect(splitAnswerChunks(answer, 160).join("")).toBe(answer);
  });

  it("빈 답변은 청크가 0개다", () => {
    expect(splitAnswerChunks("", 160)).toEqual([]);
  });

  /** 코드포인트 단위로 자른다 — UTF-16 단위면 이모지가 반토막 난다. */
  it("서로게이트 쌍을 쪼개지 않는다", () => {
    const answer = "🔥🔥🔥🔥";

    const chunks = splitAnswerChunks(answer, 2);

    expect(chunks).toEqual(["🔥🔥", "🔥🔥"]);
    expect(chunks.join("")).toBe(answer);
  });
});

describe("sseFrame", () => {
  /**
   * `data`를 JSON으로 싣는 이유는 **프레임 무결성**이다. 답변 본문에 개행이 있으면
   * 날것으로 실을 때 SSE 프레임이 거기서 끊기고, 본문에 `\n\n`이 있으면 이벤트가
   * 조기 종료된다 — 저장된 텍스트는 외부에서 들어온 것이므로 그 위조가 실재한다.
   */
  it("본문의 개행이 프레임을 끊지 못한다", () => {
    const frame = sseFrame("chunk", { text: "첫 줄\n\n둘째 줄" });

    expect(frame).toBe('event: chunk\ndata: {"text":"첫 줄\\n\\n둘째 줄"}\n\n');
    expect(frame.split("\n\n")).toHaveLength(2);
  });
});

describe("buildAnswerLogFields", () => {
  const BASE = {
    outcome: "ok",
    project: "sentinel-kb",
    stream: false,
    queryChars: 12,
    totalMs: 1.234,
  } as const;

  it("원문 쿼리를 남기지 않는다 — 길이만 남긴다", () => {
    const fields = buildAnswerLogFields(BASE);

    expect(fields).not.toHaveProperty("query");
    expect(JSON.stringify(fields)).not.toContain("커넥션");
    expect(fields.queryChars).toBe(12);
    expect(fields.event).toBe(ANSWER_LOG_EVENT);
    expect(fields.route).toBe(ANSWER_ROUTE);
  });

  it("답변 본문을 남기지 않는다 — 길이와 모델만 남긴다", () => {
    const fields = buildAnswerLogFields({
      ...BASE,
      result: {
        found: true,
        answer: "커넥션 풀 상한을 올려라 [REC-x#resolution]",
        gate: {
          passed: true,
          outcome: "above-threshold",
          thresholdEvaluated: true,
          maxVectorScore: 0.81,
          threshold: 0.62,
        },
        citations: ["[REC-x#resolution]"],
        contextChunkIds: ["chunk-1"],
        excluded: [],
        model: "fake-chat-model",
      },
      citationCount: 1,
    });

    expect(JSON.stringify(fields)).not.toContain("커넥션 풀 상한을 올려라");
    expect(fields.answerChars).toBe("커넥션 풀 상한을 올려라 [REC-x#resolution]".length);
    expect(fields.model).toBe("fake-chat-model");
  });

  /**
   * **`gatePassed`와 `gateThresholdEvaluated`는 별개 필드다** (specs/03 §4의 T-018 결정).
   * 둘을 하나로 합치면 "판정 못 한 통과"가 "판정한 통과"와 같은 칸에 들어가
   * T-013의 임계값 스윕 곡선이 오염된다. 여기서 그 분리를 잠근다.
   */
  it("판정 불가(not-evaluable)를 정상 통과와 구별해 남긴다", () => {
    const fields = buildAnswerLogFields({
      ...BASE,
      result: {
        found: true,
        answer: "답",
        gate: {
          passed: true,
          outcome: "not-evaluable",
          thresholdEvaluated: false,
          maxVectorScore: null,
          threshold: 0.62,
        },
        citations: ["[REC-x#resolution]"],
        contextChunkIds: ["chunk-1"],
        excluded: [],
        model: "fake-chat-model",
      },
    });

    expect(fields.gatePassed).toBe(true);
    expect(fields.gateThresholdEvaluated).toBe(false);
    expect(fields.gateOutcome).toBe("not-evaluable");
    expect(fields.gateMaxVectorScore).toBeNull();
  });

  it("게이트를 판정하기 전에 실패하면 게이트 필드가 아예 없다 — 0으로 접지 않는다", () => {
    const fields = buildAnswerLogFields({
      ...BASE,
      outcome: "error",
      errorCode: "VALIDATION_FAILED",
    });

    expect(fields).not.toHaveProperty("gateOutcome");
    expect(fields).not.toHaveProperty("gatePassed");
    expect(fields.found).toBeNull();
  });

  it("stream을 요청해도 열지 않았으면 streamed가 false다", () => {
    const fields = buildAnswerLogFields({
      ...BASE,
      stream: true,
      streamed: false,
      retrieval: makeRetrieval(),
    });

    expect(fields.stream).toBe(true);
    expect(fields.streamed).toBe(false);
    expect(fields.hitCount).toBe(1);
  });

  it("제외된 청크 수를 남긴다 — 오염 유입·오탐 증가의 유일한 관측 지점(T-018 F-7)", () => {
    const fields = buildAnswerLogFields({
      ...BASE,
      result: {
        found: false,
        suggestRecord: true,
        message: "유사 사례 없음",
        skipReason: "no-usable-context",
        gate: {
          passed: true,
          outcome: "above-threshold",
          thresholdEvaluated: true,
          maxVectorScore: 0.9,
          threshold: 0.62,
        },
        excluded: [
          { chunkId: "c1", recordId: RECORD_ID, flags: ["injection-suspect"], reason: "injection-suspect" },
        ],
      },
    });

    expect(fields.excludedChunkCount).toBe(1);
    expect(fields.skipReason).toBe("no-usable-context");
    expect(fields.found).toBe(false);
  });
});
