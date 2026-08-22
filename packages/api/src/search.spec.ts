/**
 * T-012 단위 테스트. **DB도 컨테이너도 쓰지 않는다** — retriever를 가짜로 주입해
 * 라우트가 하는 일(계약 검증 · 투영 · 로깅)만 결정론적으로 본다.
 * 실제 인덱스 위의 검색 품질은 `search.int.spec.ts`가 판정한다.
 *
 * **기대값은 구현 상수에서 끌어오지 않고 리터럴로 박는다**(T-007 선례). 특히 `limit`의
 * 기본값 5는 계약(`SearchRequest`)에서 온 약속이라 리터럴이어야 의미가 있다 —
 * 상수를 참조하면 상수를 8로 고쳤을 때 기대값도 따라 움직여 아무것도 검증하지 못한다.
 */
import { SearchHit, SearchResponse } from "@sentinel/contracts";
import {
  RETRIEVER_ERROR_CODES,
  RetrieverError,
  type RetrievalConfig,
  type RetrievalResult,
  type RetrieveOptions,
  type Retriever,
  type RetrievedChunk,
} from "@sentinel/core";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseApiKeys } from "@sentinel/core"; // T-037: api 사본에서 core 한 벌로.

import { createApp } from "./app.js";
import { registerAuth } from "./auth.js";
import {
  buildSearchLogFields,
  registerSearchRoutes,
  SEARCH_LOG_EVENT,
  SEARCH_ROUTE,
  toSearchHit,
} from "./search.js";

const API_KEYS = parseApiKeys("key-alpha:sentinel-kb");
const ALPHA = "Bearer key-alpha";
const SANITIZE_OPTIONS = { maskEmail: false, maxInputChars: 65_536 } as const;

/**
 * `/v1/search`는 db를 만지지 않는다 — 검색은 retriever가, records 라우트만 db를 쓴다.
 * 그 사실 자체를 이 스텁이 증명한다: 검색 테스트가 도는 동안 db는 아무 일도 하지 않는다.
 * (`as unknown as Db`는 여기서만 쓴다. 드라이버 전체를 흉내 내는 것이 목적이 아니다.)
 */
const DB_STUB = {
  collection: () => ({}),
  admin: () => ({ command: (): Promise<unknown> => Promise.resolve({ ok: 1 }) }),
} as unknown as Db;

const CONFIG_STUB: RetrievalConfig = {
  vectorK: 20,
  textK: 20,
  finalK: 8,
  rrfK: 60,
  numCandidates: 200,
  candidateOverfetch: 4,
  maxChunksPerRecord: 2,
  // T-035: 관계 확장은 기본 off다. 이 스텁이 재는 것은 확장 없는 기존 경로다.
  relationExpansion: false,
};

/* --------------------------------------------------------------------------
 * 픽스처
 * ----------------------------------------------------------------------- */

const RECORD_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RECORD_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

/** 청크 본문. **응답 어디에도 이 문자열이 나오면 안 된다**(NFR-03). */
const CHUNK_BODY_A = "[제목A] (symptom) 청크 본문이다 이 문자열은 응답에 새면 안 된다";
const CHUNK_BODY_B = "[제목B] (resolution) 두 번째 청크 본문 역시 응답 금지다";

const CHUNKS: RetrievedChunk[] = [
  {
    chunkId: "cccccccccccccccccccccccc",
    recordId: RECORD_A,
    section: "symptom",
    seq: 0,
    text: CHUNK_BODY_A,
    title: "결제 큐가 멈춘 장애",
    summary: "결제 요청이 큐에 쌓이기만 하고 소비되지 않았다.",
    type: "incident",
    project: "sentinel-kb",
    flags: ["injection-suspect"],
    fusedScore: 0.032_786_885_245_901_64,
    vectorScore: 0.91,
    textScore: 4.2,
    vectorRank: 1,
    textRank: 1,
    relation: null,
  },
  {
    chunkId: "dddddddddddddddddddddddd",
    recordId: RECORD_B,
    section: "resolution",
    seq: 1,
    text: CHUNK_BODY_B,
    title: "에이전트가 스펙 밖 엔드포인트를 추가했다",
    summary: "specs/04 표에 있는 8개 경로만 구현하기를 의도했다.",
    type: "divergence",
    project: "bizcare-web",
    flags: [],
    fusedScore: 0.016_129_032_258_064_516,
    vectorScore: null,
    textScore: 2.1,
    vectorRank: null,
    textRank: 2,
    relation: null,
  },
];

const RESULT: RetrievalResult = {
  hits: CHUNKS,
  maxVectorScore: 0.91,
  vectorCandidateCount: 12,
  textCandidateCount: 3,
};

interface LogLine {
  readonly msg?: string;
  readonly [key: string]: unknown;
}

let calls: RetrieveOptions[] = [];
let logs: LogLine[] = [];
let nextResult: RetrievalResult | Error = RESULT;
let app: FastifyInstance;

const retriever: Retriever = {
  config: CONFIG_STUB,
  retrieve: (options: RetrieveOptions): Promise<RetrievalResult> => {
    calls.push(options);
    if (nextResult instanceof Error) return Promise.reject(nextResult);
    return Promise.resolve(nextResult);
  },
};

beforeEach(async () => {
  calls = [];
  logs = [];
  nextResult = RESULT;
  app = createApp({
    db: DB_STUB,
    apiKeys: API_KEYS,
    sanitizeOptions: SANITIZE_OPTIONS,
    retriever,
    embeddingVersion: 1,
    version: "0.0.1-test",
    // 실제로 나간 로그 줄을 읽는다. 형상만 단언하면 배선이 빠져도 통과한다.
    logger: {
      level: "info",
      stream: {
        write(line: string): void {
          logs.push(JSON.parse(line) as LogLine);
        },
      },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * `authorization`에 `null`을 주면 헤더를 아예 붙이지 않는다.
 * (`undefined`가 아니라 `null`인 이유: 기본 인자는 명시적으로 넘긴 `undefined`도
 *  기본값으로 되돌려 버려 "헤더 없음" 케이스가 조용히 인증된 요청이 된다.)
 */
async function search(
  payload: unknown,
  authorization: string | null = ALPHA,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/search",
    ...(authorization === null ? {} : { headers: { authorization } }),
    payload: payload as object,
  });
  return {
    status: response.statusCode,
    raw: response.body,
    body: response.json<Record<string, unknown>>(),
  };
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body["error"] as Record<string, unknown> | undefined)?.["code"];
}

function searchLog(): LogLine {
  const line = logs.find((entry) => entry["msg"] === SEARCH_LOG_EVENT);
  expect(line, "search 로그 줄이 없다").toBeDefined();
  return line as LogLine;
}

/* --------------------------------------------------------------------------
 * 투영
 * ----------------------------------------------------------------------- */

describe("응답 투영", () => {
  it("계약이 정한 8개 필드만 담는다 — SearchHit.parse 왕복이 판정한다", async () => {
    const { status, body } = await search({ query: "결제 큐 멈춤" });

    expect(status).toBe(200);
    // **왕복 검증**: 응답을 계약으로 다시 파싱한 결과가 응답과 정확히 같아야 한다.
    // `.strict()`라 필드가 하나라도 더 붙으면 여기서 던진다 — 손으로 대조하지 않는다.
    expect(SearchResponse.parse(body)).toEqual(body);

    const results = body["results"] as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(Object.keys(results[0] ?? {}).sort()).toEqual([
      "flags",
      "project",
      "recordId",
      "score",
      "section",
      "summary",
      "title",
      "type",
    ]);
  });

  it("청크 본문이 응답 어디에도 없다 (NFR-03)", async () => {
    const { raw, body } = await search({ query: "결제 큐 멈춤" });

    // 직렬화된 문자열 전체를 훑는다. 중첩 어디에 숨어도 걸린다.
    expect(raw).not.toContain(CHUNK_BODY_A);
    expect(raw).not.toContain(CHUNK_BODY_B);
    expect(raw).not.toContain("청크 본문");
    expect(JSON.stringify(body)).not.toContain('"text"');
    expect(JSON.stringify(body)).not.toContain('"chunkId"');
    expect(JSON.stringify(body)).not.toContain('"seq"');
  });

  it("summary는 record 요약이고 청크 prefix가 붙어 있지 않다", async () => {
    const { body } = await search({ query: "결제 큐 멈춤" });
    const results = body["results"] as Record<string, unknown>[];

    expect(results[0]?.["summary"]).toBe("결제 요청이 큐에 쌓이기만 하고 소비되지 않았다.");
    // 청크 텍스트였다면 `[제목] (섹션)` prefix가 남아 있다.
    expect(String(results[0]?.["summary"])).not.toContain("(symptom)");
  });

  it("score는 fusedScore다 — vectorScore도 textScore도 아니다", async () => {
    const { body } = await search({ query: "결제 큐 멈춤" });
    const results = body["results"] as Record<string, unknown>[];

    expect(results[0]?.["score"]).toBe(0.032_786_885_245_901_64);
    expect(results[1]?.["score"]).toBe(0.016_129_032_258_064_516);
    // 이 값들이 실렸다면 척도가 갈린 것이다.
    expect(results[0]?.["score"]).not.toBe(0.91);
    expect(results[0]?.["score"]).not.toBe(4.2);
    // 텍스트 경로에서만 온 hit도 점수가 null이 아니다 — fusedScore는 항상 존재한다.
    expect(typeof results[1]?.["score"]).toBe("number");
  });

  it("flags를 그대로 노출한다 — injection-suspect도 결과에 남는다", async () => {
    const { body } = await search({ query: "결제 큐 멈춤" });
    const results = body["results"] as Record<string, unknown>[];

    expect(results[0]?.["flags"]).toEqual(["injection-suspect"]);
    expect(results[1]?.["flags"]).toEqual([]);
  });

  it("결과가 0건이면 빈 배열이다 — 404가 아니다", async () => {
    nextResult = { hits: [], maxVectorScore: null, vectorCandidateCount: 0, textCandidateCount: 0 };

    const { status, body } = await search({ query: "존재하지 않는 것" });

    expect(status).toBe(200);
    expect(body["results"]).toEqual([]);
  });

  it("toSearchHit은 청크 본문을 담지 않는다 — 순수 함수 수준의 방어선", () => {
    const chunk = CHUNKS[0] as RetrievedChunk;
    const hit = toSearchHit(chunk);

    expect(JSON.stringify(hit)).not.toContain(CHUNK_BODY_A);
    expect(SearchHit.parse(hit)).toEqual(hit);
    expect(hit.score).toBe(chunk.fusedScore);
  });
});

/* --------------------------------------------------------------------------
 * 입력 검증
 * ----------------------------------------------------------------------- */

describe("입력 검증", () => {
  it("limit이 20을 넘으면 400이다 (Acceptance 2)", async () => {
    const { status, body } = await search({ query: "결제", limit: 21 });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("VALIDATION_FAILED");
    // 검증에서 죽었으므로 retriever는 불리지 않았다.
    expect(calls).toHaveLength(0);
  });

  it("limit이 0이거나 정수가 아니면 400이다", async () => {
    expect((await search({ query: "결제", limit: 0 })).status).toBe(400);
    expect((await search({ query: "결제", limit: 2.5 })).status).toBe(400);
    expect((await search({ query: "결제", limit: "5" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("query가 2자 미만이거나 없으면 400이다", async () => {
    expect((await search({ query: "a" })).status).toBe(400);
    expect((await search({})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("계약에 없는 키는 400이다 — .strict()가 규약을 강제한다", async () => {
    const { status, body } = await search({ query: "결제", offset: 10 });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("VALIDATION_FAILED");
  });

  it("공백뿐인 query는 400이다 — 500으로 새지 않는다", async () => {
    // `min(2)`는 통과하지만 retriever가 trim 후 거부한다. 그건 클라이언트 입력 문제다.
    nextResult = new RetrieverError(RETRIEVER_ERROR_CODES.QUERY_EMPTY, "검색 쿼리가 비어 있다.");

    const { status, body } = await search({ query: "   " });

    expect(status).toBe(400);
    expect(errorCode(body)).toBe("VALIDATION_FAILED");
  });

  it("데이터 무결성 오류는 500이다 — 클라이언트가 고칠 수 있는 게 없다", async () => {
    nextResult = new RetrieverError(
      RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
      "chunks 도큐먼트가 스키마와 다르다.",
    );

    const { status, body } = await search({ query: "결제 큐" });

    expect(status).toBe(500);
    expect(errorCode(body)).toBe("INTERNAL_ERROR");
    // 내부 메시지가 그대로 새지 않는다.
    expect(JSON.stringify(body)).not.toContain("chunks 도큐먼트");
  });

  it("인증 없이는 401이다 (NFR-04)", async () => {
    const { status, body } = await search({ query: "결제 큐" }, null);

    expect(status).toBe(401);
    expect(errorCode(body)).toBe("UNAUTHORIZED");
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------
 * limit·필터 전달
 * ----------------------------------------------------------------------- */

describe("retriever 호출 인자", () => {
  it("limit을 생략하면 계약 기본값 5가 내려간다 — RETRIEVAL_FINAL_K(8)가 아니다", async () => {
    await search({ query: "결제 큐 멈춤" });

    expect(calls[0]?.limit).toBe(5);
    expect(calls[0]?.limit).not.toBe(8);
  });

  it("클라이언트가 준 limit이 그대로 내려간다", async () => {
    await search({ query: "결제 큐 멈춤", limit: 3 });

    expect(calls[0]?.limit).toBe(3);
  });

  it("limit 20(상한)도 그대로 내려간다", async () => {
    await search({ query: "결제 큐 멈춤", limit: 20 });

    expect(calls[0]?.limit).toBe(20);
  });

  it("type·project 필터를 그대로 넘긴다", async () => {
    await search({ query: "결제 큐 멈춤", type: "divergence", project: "bizcare-web" });

    expect(calls[0]).toMatchObject({
      query: "결제 큐 멈춤",
      type: "divergence",
      project: "bizcare-web",
    });
  });

  it("필터를 생략하면 키 자체를 넘기지 않는다 — undefined 주입은 필터를 건 것과 다르다", async () => {
    await search({ query: "결제 큐 멈춤" });

    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["limit", "query"]);
  });

  it("**쓰기와 달리 조회는 크로스 project다** — 키의 project를 자동으로 걸지 않는다", async () => {
    // specs/04: "project 크로스 조회는 허용(지식 공유가 목적)".
    await search({ query: "결제 큐 멈춤" });

    expect(calls[0]?.project).toBeUndefined();
  });
});

/* --------------------------------------------------------------------------
 * 레이턴시 로깅 (Scope · NFR-01)
 * ----------------------------------------------------------------------- */

describe("레이턴시 로깅", () => {
  it("성공 요청이 p95를 계산할 수 있는 로그 1줄을 남긴다", async () => {
    await search({ query: "결제 큐 멈춤", limit: 3, type: "incident" });
    const line = searchLog();

    expect(line["event"]).toBe(SEARCH_LOG_EVENT);
    expect(line["route"]).toBe(SEARCH_ROUTE);
    expect(line["outcome"]).toBe("ok");
    // NFR-01 판정 대상. 없으면 p95를 계산할 수 없다.
    expect(typeof line["totalMs"]).toBe("number");
    expect(line["totalMs"]).toBeGreaterThanOrEqual(0);
    expect(typeof line["retrievalMs"]).toBe("number");
    // T-013의 임계값 스윕 근거.
    expect(line["maxVectorScore"]).toBe(0.91);
    expect(line["vectorCandidateCount"]).toBe(12);
    expect(line["textCandidateCount"]).toBe(3);
    expect(line["hitCount"]).toBe(2);
    expect(line["limit"]).toBe(3);
    expect(line["filterType"]).toBe("incident");
    expect(line["filterProject"]).toBeNull();
    expect(line["project"]).toBe("sentinel-kb");
    expect(line["errorCode"]).toBeNull();
  });

  it("쿼리 원문을 로그에 남기지 않는다 — 길이만 남긴다", async () => {
    await search({ query: "sk-live-abcdefghijklmnop 를 어디에 넣나" });
    const line = searchLog();

    expect(JSON.stringify(line)).not.toContain("sk-live-abcdefghijklmnop");
    expect(line["queryChars"]).toBe("sk-live-abcdefghijklmnop 를 어디에 넣나".length);
  });

  it("검증 실패도 로그를 남긴다 — 실패만 빠지면 p95가 낙관적으로 편향된다", async () => {
    await search({ query: "결제", limit: 21 });
    const line = searchLog();

    expect(line["outcome"]).toBe("error");
    expect(line["errorCode"]).toBe("VALIDATION_FAILED");
    expect(typeof line["totalMs"]).toBe("number");
    // 검색까지 가지 못했으므로 검색 관련 값은 null이다 — 0이 아니다.
    expect(line["retrievalMs"]).toBeNull();
    expect(line["hitCount"]).toBeNull();
    expect(line["maxVectorScore"]).toBeNull();
  });

  it("retriever가 던져도 로그를 남긴다", async () => {
    nextResult = new RetrieverError(
      RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
      "chunks 도큐먼트가 스키마와 다르다.",
    );

    await search({ query: "결제 큐" });
    const line = searchLog();

    expect(line["outcome"]).toBe("error");
    expect(line["errorCode"]).toBe("RETRIEVER_CANDIDATE_INVALID");
    expect(typeof line["retrievalMs"]).toBe("number");
    expect(typeof line["totalMs"]).toBe("number");
  });

  it("요청 1건당 search 로그는 정확히 1줄이다 — 중복 집계는 p95를 왜곡한다", async () => {
    await search({ query: "결제 큐 멈춤" });

    expect(logs.filter((entry) => entry["msg"] === SEARCH_LOG_EVENT)).toHaveLength(1);
  });
});

describe("레이턴시 값이 실제 측정에서 온다 (주입 시계)", () => {
  /**
   * 위 라우트 테스트는 실제 시계를 쓰므로 `totalMs >= 0`밖에 단언할 수 없다 —
   * 그래서 **`totalMs`를 상수 0으로 바꾸는 변이가 그 테스트들을 그대로 통과한다.**
   * 여기서는 단조 시계를 주입해 값이 어디서 오는지 못박는다: 측정 구간이 바뀌거나
   * 상수로 대체되면 정확한 기대값이 어긋난다.
   */
  it("totalMs는 핸들러 전체, retrievalMs는 검색 구간이다", async () => {
    const ticks = [100, 110, 135, 160];
    let index = 0;
    const bare = Fastify({
      logger: {
        level: "info",
        stream: {
          write(line: string): void {
            logs.push(JSON.parse(line) as LogLine);
          },
        },
      },
    });
    registerAuth(bare, API_KEYS);
    registerSearchRoutes(bare, {
      retriever,
      monotonicNowMs: (): number => ticks[index++] ?? 999,
    });
    await bare.ready();

    await bare.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: ALPHA },
      payload: { query: "결제 큐 멈춤" },
    });

    const line = searchLog();
    expect(line["retrievalMs"]).toBe(25); // 135 − 110
    expect(line["totalMs"]).toBe(60); // 160 − 100
    await bare.close();
  });
});

describe("buildSearchLogFields", () => {
  it("측정값을 0.1ms로 반올림하고 미측정 구간은 null로 남긴다", () => {
    const fields = buildSearchLogFields({
      outcome: "ok",
      project: "sentinel-kb",
      limit: 5,
      queryChars: 12,
      result: RESULT,
      retrievalMs: 12.345_6,
      totalMs: 13.98,
    });

    expect(fields.retrievalMs).toBe(12.3);
    expect(fields.totalMs).toBe(14);
    expect(fields.errorCode).toBeNull();
    expect(fields.filterType).toBeNull();
  });

  it("결과가 없으면 검색 관련 값이 전부 null이다 — 0으로 접지 않는다", () => {
    const fields = buildSearchLogFields({
      outcome: "error",
      project: "sentinel-kb",
      limit: 5,
      queryChars: 12,
      totalMs: 1,
      errorCode: "VALIDATION_FAILED",
    });

    // "후보 0건"과 "검색을 시도조차 못했다"는 다른 상태다.
    expect(fields.vectorCandidateCount).toBeNull();
    expect(fields.textCandidateCount).toBeNull();
    expect(fields.hitCount).toBeNull();
    expect(fields.maxVectorScore).toBeNull();
  });

  it("maxVectorScore가 0이어도 null로 접히지 않는다 — 직교와 판정불가는 다르다", () => {
    const fields = buildSearchLogFields({
      outcome: "ok",
      project: "sentinel-kb",
      limit: 5,
      queryChars: 12,
      result: { hits: [], maxVectorScore: 0, vectorCandidateCount: 3, textCandidateCount: 0 },
      retrievalMs: 1,
      totalMs: 2,
    });

    expect(fields.maxVectorScore).toBe(0);
  });
});

/* --------------------------------------------------------------------------
 * 배선
 * ----------------------------------------------------------------------- */

describe("retriever 미주입", () => {
  it("retriever가 없으면 라우트 자체가 없다 — 500이 아니라 404다", async () => {
    const bare = createApp({
      db: DB_STUB,
      apiKeys: API_KEYS,
      sanitizeOptions: SANITIZE_OPTIONS,
      embeddingVersion: 1,
      version: "0.0.1-test",
    });
    await bare.ready();

    const response = await bare.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: ALPHA },
      payload: { query: "결제 큐" },
    });

    expect(response.statusCode).toBe(404);
    await bare.close();
  });
});
