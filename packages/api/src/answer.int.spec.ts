/**
 * T-019 통합 테스트. **실제 Fastify 앱에 `app.inject()`로 HTTP 왕복을 한다** — 핸들러를
 * 직접 부르면 인증·계약 검증·응답 헤더·SSE 프레이밍이 통째로 빠지고, 정작 T-018 F-2가
 * 지목한 위험("헤더를 먼저 흘려보낸 뒤 게이트에 걸린다")은 **헤더에서만** 관측된다.
 *
 * ## Mongo도 Docker도 쓰지 않는다 — 대신 fake 임베더로 **실제 cosine을 계산한다**
 *
 * `/v1/search` 통합 테스트(T-012)는 atlas-local이 필요하지만, 이 라우트가 판정 대상으로
 * 삼는 것은 벡터 인덱스가 아니라 **retriever가 준 `maxVectorScore`를 어떻게 다루는가**다.
 * 그래서 retriever를 스텁으로 두되 `maxVectorScore`를 손으로 박지 않고
 * `createFakeEmbedder()`로 질의와 코퍼스를 임베딩해 **cosine을 실제로 계산**한다.
 *
 * 이유는 T-015 F-D가 경고한 공허한 그린 때문이다: `maxVectorScore`를 테스트가 직접 써넣으면
 * "무관한 쿼리 5개가 전부 found:false"는 **테스트가 스스로 만든 값**을 확인하는 동어반복이
 * 된다. fake 임베더는 해시 기반이라 서로 다른 텍스트 간 cosine ≈ 0이고 같은 텍스트끼리는
 * 1.0이므로, 미달 갈래와 통과 갈래가 **계산 결과로** 갈린다. 대조군(같은 텍스트 질의 →
 * found:true)이 함께 있어야 "전부 false"가 게이트 때문이지 배선이 죽어서가 아님이 드러난다.
 *
 * **한계는 정직하게 적는다**: 이 방식은 "의미적으로 무관한가"를 판정하지 못한다.
 * fake 임베딩에서 의미는 아무 역할도 하지 않는다 — 그 판정은 실 임베딩 위의 eval(T-013)의
 * 몫이고, 여기서 재는 것은 "게이트가 미달을 실제로 막는가"다.
 */
import { AnswerResponse } from "@sentinel/contracts";
import {
  createFakeChatModel,
  createFakeEmbedder,
  parseApiKeys,
  type ChatModel,
  type Embedder,
  type FakeChatModel,
  type GeneratorConfig,
  type RetrievalResult,
  type RetrievedChunk,
  type Retriever,
} from "@sentinel/core";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { ANSWER_LOG_EVENT, SSE_CONTENT_TYPE } from "./answer.js";

/** 라우트 등록은 DB를 건드리지 않는다(`openapi.spec.ts`와 같은 스텁). */
const DB_STUB = { collection: () => ({}) } as unknown as Db;

const API_KEYS = parseApiKeys("key-alpha:sentinel-kb");
const AUTH = { authorization: "Bearer key-alpha" };

const RECORD_ID = "68f0c4a1b2c3d4e5f6a7b8c9";
const TAINTED_RECORD_ID = "68f0c4a1b2c3d4e5f6a7b8ca";

/** 게이트 임계값. `.env.example`의 기본값과 같은 값을 **명시적으로** 주입한다. */
const CONFIG: GeneratorConfig = { similarityThreshold: 0.62, answerMaxTokens: 2048 };

/** 코퍼스 1건. 질의가 이 텍스트와 정확히 같으면 cosine 1.0, 다르면 fake 임베더에서 ≈ 0이다. */
const CORPUS_TEXT = "커넥션 풀 상한을 20으로 올리고 애플리케이션을 재시작했다.";

const EMBEDDER: Embedder = createFakeEmbedder({ dim: 16, version: 1 });

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function makeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "chunk-1",
    recordId: RECORD_ID,
    section: "resolution",
    seq: 0,
    text: CORPUS_TEXT,
    title: "커넥션 풀 고갈",
    summary: "커넥션 풀 상한을 올려 해결했다.",
    type: "incident",
    project: "sentinel-kb",
    flags: [],
    fusedScore: 0.016_393_442_622_950_82,
    vectorScore: 0.81,
    textScore: null,
    vectorRank: 0,
    textRank: null,
    relation: null,
    ...overrides,
  };
}

/**
 * 질의를 **실제로 임베딩해서** 코퍼스와의 원시 cosine을 재는 retriever 스텁.
 * `maxVectorScore`가 여기서 계산되므로 테스트가 게이트 결과를 미리 정하지 못한다.
 */
function makeRetriever(hits: RetrievedChunk[] = [makeChunk()]): Retriever {
  return {
    config: {} as Retriever["config"],
    retrieve: async ({ query }): Promise<RetrievalResult> => {
      const [queryVec = [], corpusVec = []] = await EMBEDDER.embed([query, CORPUS_TEXT]);
      return {
        hits,
        maxVectorScore: cosine(queryVec, corpusVec),
        vectorCandidateCount: hits.length,
        textCandidateCount: 0,
      };
    },
  };
}

/** 벡터 경로 0건 — `maxVectorScore`가 `0`이 아니라 `null`인 상태(T-011 F-B의 그 케이스). */
function makeTextOnlyRetriever(hits: RetrievedChunk[] = [makeChunk()]): Retriever {
  return {
    config: {} as Retriever["config"],
    retrieve: (): Promise<RetrievalResult> =>
      Promise.resolve({
        hits,
        maxVectorScore: null,
        vectorCandidateCount: 0,
        textCandidateCount: hits.length,
      }),
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly model: FakeChatModel;
  readonly logs: Record<string, unknown>[];
}

let harnesses: FastifyInstance[] = [];

function makeHarness(retriever: Retriever, model?: ChatModel): Harness {
  const chatModel =
    model ?? createFakeChatModel({ reply: () => `해결: 풀 상한을 올려라 [REC-${RECORD_ID}#resolution]` });
  const logs: Record<string, unknown>[] = [];

  const app = createApp({
    db: DB_STUB,
    apiKeys: API_KEYS,
    sanitizeOptions: { maskEmail: false, maxInputChars: 65_536 },
    embeddingVersion: 1,
    version: "0.0.1-test",
    retriever,
    chatModel,
    // **env에 결합되지 않게 임계값을 명시적으로 주입한다.** 주입하지 않으면 실행 환경의
    // `SIMILARITY_THRESHOLD`가 게이트 테스트를 조용히 뒤집을 수 있다.
    generatorConfig: CONFIG,
    // **실제로 나간 로그 줄**을 검사한다. 형상만 단언하면 필드가 빠져도 아무도 모른다.
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    },
  });
  harnesses.push(app);
  return { app, model: chatModel as FakeChatModel, logs };
}

function answerLog(logs: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return logs.find((line) => line["event"] === ANSWER_LOG_EVENT);
}

beforeEach(() => {
  harnesses = [];
});

afterEach(async () => {
  await Promise.all(harnesses.map((app) => app.close()));
});

// ================================================================ 게이트 ↔ 스트림 순서

describe("게이트는 스트림 시작 앞에 있다 (T-018 F-2)", () => {
  /**
   * **이 태스크에서 가장 중요한 단언이다.**
   *
   * T-018은 "임계값 미달이면 생성 호출이 아예 발생하지 않는다"를 스파이로 잠갔다.
   * SSE에서 헤더를 먼저 흘려보낸 뒤 게이트에 걸리면 그 보장이 HTTP 표면에서 되돌려진다 —
   * 클라이언트는 스트림이 열리는 것을 보고 "생성이 시작됐다"를 관측하기 때문이다.
   *
   * 관측 경로는 **두 개를 함께** 본다: (a) content-type이 `text/event-stream`이 아니고,
   * (b) 모델 호출이 0건. (b)만 보면 "헤더는 흘렸지만 모델은 안 불렀다"가 통과하고,
   * (a)만 보면 "JSON으로 답했지만 모델은 불렀다"가 통과한다.
   */
  it("미달 요청에 stream:true를 줘도 SSE를 시작하지 않고 모델도 부르지 않는다", async () => {
    const { app, model, logs } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: "전혀 관련 없는 다른 이야기입니다", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).not.toContain(SSE_CONTENT_TYPE);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(model.calls, "게이트 미달인데 모델을 불렀다").toHaveLength(0);
    expect(response.json()).toEqual({
      found: false,
      message: "유사 사례 없음",
      suggestRecord: true,
    });

    const log = answerLog(logs);
    expect(log?.["stream"]).toBe(true);
    expect(log?.["streamed"], "found:false인데 스트림을 열었다").toBe(false);
    expect(log?.["gateOutcome"]).toBe("below-threshold");
  });

  it("미달 응답은 계약(AnswerResponse)의 found:false 갈래를 만족한다", async () => {
    const { app } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: "전혀 관련 없는 다른 이야기입니다" },
    });

    expect(() => AnswerResponse.parse(response.json())).not.toThrow();
  });
});

// ================================================================ SSE 스트리밍

describe("SSE 스트리밍 (Acceptance 1)", () => {
  it("청크 단위로 도착하고 완료 이벤트로 끝난다", async () => {
    /*
     * **모든 문장에 인용이 붙어 있다.** T-020이 specs/03 §5 검증을 `generateAnswer` 안에
     * 넣은 뒤로, 마지막 문장에만 인용을 단 답변은 앞 19문장이 위반이라 제거된다 —
     * 그러면 이 테스트가 재려는 것(청크 분할·재조립)이 아니라 문장 제거를 재게 된다.
     * 픽스처를 §5를 만족하는 답변으로 바꾼 것이고, 단언은 그대로다.
     */
    const answer = `${"해결 절차를 자세히 적는다 [REC-".concat(RECORD_ID, "#resolution]. ").repeat(20)}`.trim();
    const { app, logs } = makeHarness(
      makeRetriever(),
      createFakeChatModel({ reply: () => answer }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT, stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(SSE_CONTENT_TYPE);

    const frames = response.body.split("\n\n").filter((frame) => frame.length > 0);
    const events = frames.map((frame) => frame.split("\n")[0]);

    // 청크가 **여러 개**여야 "청크 단위로 도착"이 관측된다. 1개면 완료 이벤트 앞의 덤일 뿐이다.
    expect(events.filter((event) => event === "event: chunk").length).toBeGreaterThan(1);
    // 완료 이벤트는 **마지막 하나**다.
    expect(events.at(-1)).toBe("event: done");
    expect(events.filter((event) => event === "event: done")).toHaveLength(1);

    // 청크를 이어 붙이면 답변 원문이다 — 조각이 유실되거나 중복되면 여기서 죽는다.
    const streamedText = frames
      .filter((frame) => frame.startsWith("event: chunk"))
      .map((frame) => (JSON.parse(frame.split("data: ")[1] ?? "{}") as { text: string }).text)
      .join("");
    expect(streamedText).toBe(answer);

    // 완료 이벤트가 인용을 싣는다 (recordId 추적 가능성).
    const doneFrame = frames.at(-1) ?? "";
    const done = JSON.parse(doneFrame.split("data: ")[1] ?? "{}") as {
      found: boolean;
      citations: { recordId: string }[];
    };
    expect(done.found).toBe(true);
    expect(done.citations.map((citation) => citation.recordId)).toEqual([RECORD_ID]);

    expect(answerLog(logs)?.["streamed"]).toBe(true);
  });

  /**
   * nginx가 SSE를 버퍼링하면 스트리밍이 죽는다 — 시드 INC-06이 정확히 그 사건이다.
   * specs/06의 nginx 블록은 `/mcp`에만 `proxy_buffering off`를 걸어 두었고 `/v1`에는 없다.
   * 이 헤더는 conf와 무관하게 **응답 단위로** 버퍼링을 끄는 방어선이다(conf는 T-026에 인계).
   */
  it("X-Accel-Buffering: no를 실어 프록시 버퍼링을 끈다", async () => {
    const { app } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT, stream: true },
    });

    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["cache-control"]).toContain("no-cache");
  });

  it("stream 없이 부르면 같은 답을 JSON 한 덩어리로 준다", async () => {
    const answer = `해결: 풀 상한을 올려라 [REC-${RECORD_ID}#resolution]`;
    const { app } = makeHarness(makeRetriever(), createFakeChatModel({ reply: () => answer }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({ found: true, answer });
  });
});

// ================================================================ 무관한 쿼리

describe("무관한 쿼리 (Acceptance 2)", () => {
  /**
   * 다섯 질의 전부 코퍼스와 다른 텍스트다 → fake 임베딩에서 cosine ≈ 0 → 0.62 미달.
   * **값은 테스트가 정하지 않는다** — retriever 스텁이 실제로 계산한다.
   */
  const UNRELATED = [
    "점심 메뉴 추천해 줘",
    "이 프로젝트의 라이선스는 무엇인가",
    "쿠버네티스 파드가 왜 Pending 상태인가",
    "회사 연차 규정이 어떻게 되나",
    "TypeScript에서 제네릭 기본값 문법",
  ];

  it("무관한 쿼리 5개가 전부 found:false + suggestRecord:true다", async () => {
    for (const query of UNRELATED) {
      const { app, model } = makeHarness(makeRetriever());
      const response = await app.inject({
        method: "POST",
        url: "/v1/answer",
        headers: AUTH,
        payload: { query },
      });

      expect(response.json(), `"${query}"가 found:false가 아니다`).toEqual({
        found: false,
        message: "유사 사례 없음",
        suggestRecord: true,
      });
      expect(model.calls, `"${query}"에서 모델을 불렀다`).toHaveLength(0);
    }
  });

  /**
   * **대조군.** 위 다섯이 전부 false인 것이 게이트 때문이지 배선이 죽어서가 아님을 못박는다.
   * 이게 없으면 `generateAnswer`를 통째로 `found:false` 반환으로 바꿔도 전부 통과한다.
   */
  it("대조군: 코퍼스와 같은 질의는 found:true다", async () => {
    const { app, model } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    expect(response.json()).toMatchObject({ found: true });
    expect(model.calls).toHaveLength(1);
  });
});

// ================================================================ 게이트 판정 불가

describe("maxVectorScore === null (T-018 D-1)", () => {
  /**
   * **"판정 불가"는 "통과"와 다르고 "미달"과도 다르다.**
   * 통과시키되 `gateThresholdEvaluated:false`로 남긴다 — T-013이 스윕에서 이 케이스를
   * 분리해 집계해야 곡선이 오염되지 않는다. `gatePassed`와 합치면 이 단언이 죽는다.
   */
  it("텍스트 경로 단독 hit은 답을 내되 판정 불가를 로그에 남긴다", async () => {
    const { app, logs } = makeHarness(makeTextOnlyRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: "무엇이든 상관없다" },
    });

    expect(response.json()).toMatchObject({ found: true });

    const log = answerLog(logs);
    expect(log?.["gatePassed"]).toBe(true);
    expect(log?.["gateThresholdEvaluated"]).toBe(false);
    expect(log?.["gateOutcome"]).toBe("not-evaluable");
    expect(log?.["gateMaxVectorScore"]).toBeNull();
  });
});

// ================================================================ 인용·본문 경계

describe("인용과 본문 경계", () => {
  /** `injection-suspect` 제외는 T-018이 한다. 여기서는 **되돌리지 않는지**만 본다. */
  it("제외된 청크는 인용에 나타나지 않는다", async () => {
    const retriever = makeRetriever([
      makeChunk(),
      makeChunk({
        chunkId: "chunk-2",
        recordId: TAINTED_RECORD_ID,
        flags: ["injection-suspect"],
      }),
    ]);
    const { app, logs } = makeHarness(retriever);

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    const body = response.json() as { citations: { recordId: string }[] };
    expect(body.citations.map((citation) => citation.recordId)).toEqual([RECORD_ID]);
    expect(answerLog(logs)?.["excludedChunkCount"]).toBe(1);
  });

  /** NFR-03·T-018 F-3: 청크 본문은 HTTP 표면으로 나가지 않는다. */
  it("응답에 청크 본문이 실리지 않는다", async () => {
    const { app } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    expect(response.body).not.toContain(CORPUS_TEXT);
  });

  /**
   * **근거 없는 답변은 계약에서 죽는다** (FR-04·NFR-02). `citations.min(1)`이 그 방어선이고,
   * 투영이 인용을 전부 흘려버리면 답변만 나가는 대신 500이 난다.
   * 여기서는 `contextChunkIds`와 hits의 대응이 깨진 상태를 만든다.
   */
  it("인용이 하나도 남지 않으면 답변을 내보내지 않는다", async () => {
    // hits에 없는 chunkId만 컨텍스트에 들어간 상태 — hits를 비워 대응을 끊는다.
    const retriever: Retriever = {
      config: {} as Retriever["config"],
      retrieve: () =>
        Promise.resolve({
          hits: [],
          maxVectorScore: 0.99,
          vectorCandidateCount: 0,
          textCandidateCount: 0,
        }),
    };
    const { app } = makeHarness(retriever);

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    // hits가 0건이면 컨텍스트도 0건이라 generateAnswer가 먼저 no-usable-context로 막는다.
    // 어느 쪽이든 **인용 없는 답변은 나가지 않는다**는 것이 판정 대상이다.
    expect(response.json()).not.toMatchObject({ found: true });
  });
});

// ================================================================ 인용 후처리 검증 (T-020)

/**
 * **specs/03 §5가 HTTP 표면에서 실제로 이행되는지** 본다. 단위 테스트는 core의 판정과
 * 로그 필드 생성을 각각 잠그지만, 그 둘이 라우트에서 **이어져 있는지**는 여기서만 보인다.
 *
 * T-019가 남긴 M5b가 이 describe의 존재 이유다: 인용 마커가 0개인 답변이
 * `found:true` + `citations:[...]`로 나가던 상태를 실측으로 재현하고 죽인다.
 */
describe("인용 후처리 검증 (specs/03 §5, T-020)", () => {
  it("인용 마커가 0개인 답변은 found:true로 나가지 않는다 (T-019 M5b)", async () => {
    const { app, model, logs } = makeHarness(
      makeRetriever(),
      createFakeChatModel({ reply: () => "커넥션 풀 상한을 올리면 해결된다. 재시작하라." }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    // 게이트는 통과했다(코퍼스와 같은 질의라 cosine 1.0). 막은 것은 §5 검증이다.
    expect(answerLog(logs)?.["gatePassed"]).toBe(true);
    expect(response.json()).not.toMatchObject({ found: true });
    // 1회 재생성이 실제로 일어났다 — 스펙이 요구한 그 한 번이다.
    expect(model.calls).toHaveLength(2);
  });

  /** **`groundingViolation`이 조용히 지나가지 않는다** — 실제로 나간 로그 줄을 읽는다. */
  it("groundingViolation이 실제 로그 줄에 남는다", async () => {
    const { app, logs } = makeHarness(
      makeRetriever(),
      createFakeChatModel({ reply: () => "커넥션 풀 상한을 올리면 해결된다. 재시작하라." }),
    );

    await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    const log = answerLog(logs);
    expect(log?.["groundingViolation"], "위반이 로그에 남지 않는다").toBe(true);
    expect(log?.["groundingRegenerated"]).toBe(true);
    expect(log?.["groundingCitedSentences"]).toBe(0);
    expect(log?.["skipReason"]).toBe("grounding-violation");
  });

  /** 인용이 붙은 정상 답변에서는 위반이 `false`이지 `null`이 아니다 — 판정은 했다. */
  it("정상 답변에서는 groundingViolation:false가 남는다", async () => {
    const { app, model, logs } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    expect(response.json()).toMatchObject({ found: true });
    expect(model.calls, "재생성이 불필요한데 두 번 불렀다").toHaveLength(1);
    const log = answerLog(logs);
    expect(log?.["groundingViolation"]).toBe(false);
    expect(log?.["groundingRegenerated"]).toBe(false);
  });

  /** 게이트에서 끝난 요청은 검증까지 가지 않았으므로 `null`이다. `false`로 접지 않는다. */
  it("게이트 미달 요청의 grounding 필드는 null이다", async () => {
    const { app, logs } = makeHarness(makeRetriever());

    await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: "전혀 관련 없는 다른 이야기입니다" },
    });

    expect(answerLog(logs)?.["groundingViolation"]).toBeNull();
  });

  /** **모델이 지어낸 ObjectId는 형식이 완벽하다.** 컨텍스트 대조가 없으면 그대로 나간다. */
  it("컨텍스트에 없는 ID를 인용한 문장은 응답에서 사라진다", async () => {
    const invented = `[REC-${TAINTED_RECORD_ID}#resolution]`;
    const { app } = makeHarness(
      makeRetriever(),
      createFakeChatModel({
        reply: () =>
          `풀 상한을 올렸다 [REC-${RECORD_ID}#resolution]. 인덱스를 다시 만들었다 ${invented}.`,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT },
    });

    const body = response.json() as { found: boolean; answer: string };
    expect(body.found).toBe(true);
    expect(body.answer, "지어낸 인용이 그대로 나갔다").not.toContain(invented);
    expect(body.answer).toContain(`[REC-${RECORD_ID}#resolution]`);
  });
});

// ================================================================ 계약·인증

describe("계약과 인증", () => {
  it("인증 없이는 401이다", async () => {
    const { app } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      payload: { query: CORPUS_TEXT },
    });

    expect(response.statusCode).toBe(401);
  });

  it("계약을 만족하지 않는 바디는 400이고 모델을 부르지 않는다", async () => {
    const { app, model, logs } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: "짧" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(model.calls).toHaveLength(0);
    // 검증 실패도 로그를 남긴다 — 400만 조용히 넘기면 p95가 낙관적으로 보인다(`search.ts` 규약).
    expect(answerLog(logs)?.["outcome"]).toBe("error");
  });

  it("계약에 없는 키는 거부한다 (.strict())", async () => {
    const { app } = makeHarness(makeRetriever());

    const response = await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: CORPUS_TEXT, limit: 3 },
    });

    expect(response.statusCode).toBe(400);
  });

  it("레이턴시 로그에 원문 쿼리가 남지 않는다", async () => {
    const secret = "api_key=sk-live-0123456789 때문에 실패한다";
    const { app, logs } = makeHarness(makeRetriever());

    await app.inject({
      method: "POST",
      url: "/v1/answer",
      headers: AUTH,
      payload: { query: secret },
    });

    const log = answerLog(logs);
    expect(JSON.stringify(log)).not.toContain("sk-live-0123456789");
    expect(log?.["queryChars"]).toBe(secret.length);
    expect(typeof log?.["totalMs"]).toBe("number");
  });
});
