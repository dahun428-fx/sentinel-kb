/**
 * T-022 통합 테스트. specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를 허용한다 —
 * 피드백 경로는 벡터 검색을 쓰지 않으므로 메모리 서버로 충분하다.
 *
 * **env의 MONGODB_URI에 의존하지 않는다.** CI의 integration 스텝은 존재하지 않는 시크릿을
 * 주입해 빈 문자열이 들어온다(T-003이 확인). 메모리 서버를 여기서 직접 띄우고 그 URI만 쓴다.
 */
import { EvalCaseSchema } from "@sentinel/contracts";
import { connect } from "@sentinel/core/db";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
// T-037이 `parseApiKeys`를 `@sentinel/core`로 승격했다(인증 복제 회수).
import { parseApiKeys } from "@sentinel/core";
import {
  APPROVED_EVAL_CASE_FILTER,
  EVAL_CASE_CANDIDATE_FILTER,
  evalCaseCandidateId,
  evalCasesCollection,
  feedbacksCollection,
  type EvalCaseDocument,
  type FeedbackDocument,
} from "./feedback.js";

const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const DB_NAME = "sentinel_feedback_int_test";

/** 실제 파서를 통과시킨다 — 형식 규약까지 함께 잠근다. */
const API_KEYS = parseApiKeys("key-alpha:sentinel-kb,key-beta:bizcare-web");
const ALPHA = "Bearer key-alpha"; // project: sentinel-kb
const BETA = "Bearer key-beta"; // project: bizcare-web

const SANITIZE_OPTIONS = { maskEmail: false, maxInputChars: 65_536 } as const;

/** 리터럴 ObjectId hex. 레코드 존재 여부는 이 라우트의 관심사가 아니다(Findings 참조). */
const RECORD_A = "6650a1b2c3d4e5f601020304";
const RECORD_B = "6650a1b2c3d4e5f601020305";
const QUERY = "결제 큐가 멈췄을 때 무엇을 봤나";

const CREATED_AT = new Date("2026-05-01T00:00:00.000Z");

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: FastifyInstance;
let clock = CREATED_AT.getTime();

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db(DB_NAME);
  app = createApp({
    db,
    apiKeys: API_KEYS,
    sanitizeOptions: SANITIZE_OPTIONS,
    embeddingVersion: 7,
    version: "0.0.1-test",
    now: () => new Date(clock),
  });
  await app.ready();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  clock = CREATED_AT.getTime();
  await Promise.all(
    ["feedbacks", "eval_cases"].map(async (name) => db.collection(name).deleteMany({})),
  );
});

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

/**
 * `authorization`에 `null`을 주면 헤더를 붙이지 않는다.
 * `undefined`가 아니라 `null`인 이유: 기본값 파라미터는 명시적 `undefined`에도 발동해서
 * "헤더 없음"을 표현할 수 없다 — 그러면 401 테스트가 조용히 인증된 요청을 보낸다.
 */
async function postFeedback(
  payload: unknown,
  authorization: string | null = ALPHA,
): Promise<JsonResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/feedback",
    ...(authorization === null ? {} : { headers: { authorization } }),
    payload: payload as object,
  });
  return {
    status: response.statusCode,
    body: response.body === "" ? undefined : response.json<Record<string, unknown>>(),
  };
}

function errorCode(response: JsonResponse): unknown {
  return (response.body?.["error"] as Record<string, unknown> | undefined)?.["code"];
}

async function feedbacks(): Promise<FeedbackDocument[]> {
  return feedbacksCollection(db).find({}).toArray();
}

async function candidates(): Promise<EvalCaseDocument[]> {
  return evalCasesCollection(db).find(EVAL_CASE_CANDIDATE_FILTER).toArray();
}

async function goldenSet(): Promise<EvalCaseDocument[]> {
  return evalCasesCollection(db).find(APPROVED_EVAL_CASE_FILTER).toArray();
}

// ---------------------------------------------------------------- 저장

describe("POST /v1/feedback", () => {
  it("피드백을 저장하고 204를 준다 — 계약에 응답 스키마가 없으므로 본문을 만들지 않는다", async () => {
    const response = await postFeedback({
      recordId: RECORD_A,
      query: QUERY,
      helped: true,
      note: "재기동 절차가 그대로 먹혔다",
    });

    expect(response.status).toBe(204);
    const stored = await feedbacks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      recordId: new ObjectId(RECORD_A),
      query: QUERY,
      helped: true,
      note: "재기동 절차가 그대로 먹혔다",
      project: "sentinel-kb",
      createdAt: CREATED_AT,
    });
  });

  it("project는 인증 키에서 온다 — 다른 키로 보낸 같은 요청은 다른 project로 저장된다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: false }, BETA);

    const stored = await feedbacks();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.project).toBe("bizcare-web");
  });

  it("바디에 project가 오면 400으로 거부하고 아무것도 저장하지 않는다", async () => {
    const response = await postFeedback({
      recordId: RECORD_A,
      query: QUERY,
      helped: true,
      project: "bizcare-web",
    });

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("PROJECT_NOT_ALLOWED_IN_BODY");
    expect(await feedbacks()).toHaveLength(0);
  });

  it("인증 없이는 401이다", async () => {
    const response = await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true }, null);

    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("UNAUTHORIZED");
    expect(await feedbacks()).toHaveLength(0);
  });

  it.each([
    ["helped가 없다", { recordId: RECORD_A, query: QUERY }],
    ["recordId가 hex가 아니다", { recordId: "not-an-object-id", query: QUERY, helped: true }],
    ["query가 비었다", { recordId: RECORD_A, query: "", helped: true }],
    ["계약에 없는 키가 있다", { recordId: RECORD_A, query: QUERY, helped: true, extra: 1 }],
  ])("%s면 400이다", async (_label, payload) => {
    const response = await postFeedback(payload);

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("VALIDATION_FAILED");
    expect(await feedbacks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 중복

describe("중복 피드백", () => {
  it("같은 (recordId, query)는 새 문서를 만들지 않고 갱신한다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true, note: "도움 됐다" });
    clock = new Date("2026-05-02T00:00:00.000Z").getTime();
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: false });

    const stored = await feedbacks();
    expect(stored).toHaveLength(1);
    // 마지막 판단이 이긴다. note를 빼고 다시 보냈으므로 이전 note는 남지 않는다.
    expect(stored[0]?.helped).toBe(false);
    expect(stored[0]?.note).toBeUndefined();
    // 최초 기록 시점은 유지된다.
    expect(stored[0]?.createdAt).toEqual(CREATED_AT);
  });

  it("project가 다르면 다른 피드백이다 — 한 프로젝트가 다른 프로젝트의 판단을 덮지 않는다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true }, ALPHA);
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: false }, BETA);

    const stored = await feedbacks();
    expect(stored).toHaveLength(2);
    expect(stored.map((doc) => doc.project).sort()).toEqual(["bizcare-web", "sentinel-kb"]);
  });
});

// ---------------------------------------------------------------- 골든셋 경계

describe("eval_cases 후보", () => {
  it("helped=true면 후보 목록에 나타난다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      query: QUERY,
      expectedRecordIds: [new ObjectId(RECORD_A)],
    });
  });

  it("helped=false는 후보를 만들지 않는다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: false });

    expect(await evalCasesCollection(db).countDocuments({})).toBe(0);
  });

  it("승인 없이는 골든셋에 나타나지 않고 EvalCaseSchema도 통과하지 못한다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });

    // eval 러너가 읽는 집합(사람 승인분만, specs/05)에는 없다.
    expect(await goldenSet()).toHaveLength(0);

    // 계약으로 파싱해도 실패한다 — approvedBy가 없기 때문이다.
    const [candidate] = await candidates();
    expect(candidate).toBeDefined();
    expect(candidate?.approvedBy).toBeUndefined();
    expect(
      EvalCaseSchema.safeParse({
        ...candidate,
        _id: candidate?._id.toHexString(),
        expectedRecordIds: candidate?.expectedRecordIds.map((id) => id.toHexString()),
      }).success,
    ).toBe(false);
  });

  it("같은 query에 여러 레코드가 도움이 됐으면 후보 하나에 모인다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });
    await postFeedback({ recordId: RECORD_B, query: QUERY, helped: true }, BETA);

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.expectedRecordIds.map((id) => id.toHexString()).sort()).toEqual(
      [RECORD_A, RECORD_B].sort(),
    );
  });

  it("같은 피드백을 두 번 보내도 정답 목록이 부풀지 않는다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });

    const pending = await candidates();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.expectedRecordIds).toHaveLength(1);
  });

  it("이미 승인된 케이스는 피드백으로 바뀌지 않는다 — 자동 승격 금지의 반대편(specs/02)", async () => {
    const approvedId = evalCaseCandidateId(QUERY);
    await evalCasesCollection(db).insertOne({
      _id: approvedId,
      query: QUERY,
      expectedRecordIds: [new ObjectId(RECORD_B)],
      approvedBy: "human",
    });

    const response = await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });
    expect(response.status).toBe(204);

    // 승인된 문서의 정답 목록이 늘지 않았다.
    const golden = await goldenSet();
    expect(golden).toHaveLength(1);
    expect(golden[0]?.expectedRecordIds).toEqual([new ObjectId(RECORD_B)]);
    // 후보도 새로 생기지 않는다 — 같은 query의 케이스는 이미 사람 손을 거쳤다.
    expect(await candidates()).toHaveLength(0);
    // 그래도 피드백 자체는 남는다. 사람이 이걸 보고 골든셋을 고칠 수 있어야 한다.
    expect(await feedbacks()).toHaveLength(1);
  });

  it("후보에는 approvedBy가 어떤 값으로도 쓰이지 않는다", async () => {
    await postFeedback({ recordId: RECORD_A, query: QUERY, helped: true });

    expect(await evalCasesCollection(db).countDocuments({ approvedBy: { $exists: true } })).toBe(0);
  });
});
