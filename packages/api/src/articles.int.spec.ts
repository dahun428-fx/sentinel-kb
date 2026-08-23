/**
 * B-1 통합 테스트 — `/v1/articles` 4개 오퍼레이션. specs/04 표, specs/08 §0-5·§2·§4·§7.
 * specs/05가 "Integration: … mongodb-memory-server(벡터 외)"를 허용한다.
 *
 * **env의 MONGODB_URI에 의존하지 않는다.** CI의 integration 스텝은 존재하지 않는 시크릿을
 * 주입해 빈 문자열이 들어온다(T-003이 확인). 메모리 서버를 여기서 직접 띄우고 그 URI만 쓴다.
 *
 * **기대값은 구현 상수에서 끌어오지 않고 리터럴로 박는다.** 상수를 참조하면 상수를 고쳤을 때
 * 기대값도 따라 움직여 아무것도 검증하지 못한다(T-041 래칫이 잡는 형태).
 *
 * 이 파일의 무게중심은 **목록 기본값**이다. specs/04가 "기본은 published만"을 정한 이유는
 * 필터를 빠뜨렸을 때의 결과가 안전한 쪽이어야 하기 때문이고, 그 성질은 계약(기본값)과
 * 라우트(무조건 필터) 두 곳이 함께 지킨다. 어느 한쪽만 봐서는 노출 여부를 알 수 없으므로
 * **실제 HTTP 응답으로** 관측한다.
 */
import { connect, ensureIndexes } from "@sentinel/core/db";
import type { FastifyInstance } from "fastify";
import { ObjectId, type Db, type MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseApiKeys } from "@sentinel/core";

import { createApp } from "./app.js";

const BOOT_TIMEOUT_MS = 120_000; // 첫 실행은 mongod 바이너리를 내려받는다
const DB_NAME = "sentinel_articles_int_test";

const API_KEYS = parseApiKeys("key-alpha:sentinel-kb,key-beta:bizcare-web");
const ALPHA = "Bearer key-alpha"; // project: sentinel-kb
const BETA = "Bearer key-beta"; // project: bizcare-web

const SANITIZE_OPTIONS = { maskEmail: false, maxInputChars: 65_536 } as const;

/** 주입된 시계. **`publishedAt`이 여기서 나온다** — 서버가 찍는다는 것을 이 값으로 관측한다. */
const SERVER_NOW = "2026-08-20T09:30:00.000Z";
/** 클라이언트가 보내려 시도하는 값. 서버 시계와 **반드시 달라야** 관측이 성립한다. */
const CLIENT_FORGED_AT = "2001-01-01T00:00:00.000Z";

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await connect({
    uri: server.getUri(),
    dbName: DB_NAME,
    serverSelectionTimeoutMS: 10_000,
  });
  db = client.db(DB_NAME);
  await ensureIndexes(db);
  app = createApp({
    db,
    apiKeys: API_KEYS,
    sanitizeOptions: SANITIZE_OPTIONS,
    embeddingVersion: 7,
    version: "0.0.1-test",
    now: () => new Date(SERVER_NOW),
  });
  await app.ready();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await client.close();
  await server.stop();
});

beforeEach(async () => {
  await db.collection("articles").deleteMany({});
});

// ---------------------------------------------------------------- fixtures

const SOURCE_ID = new ObjectId("0123456789abcdef01234567");

const BODY = "## 사건\n2026-08-01 03:12에 `ECONNRESET`이 났다. 재시도 3회 후 큐가 멈췄다.";

interface SeedOptions {
  readonly status: "candidate" | "draft" | "published" | "rejected";
  readonly title: string;
  readonly slug: string;
  readonly withBody?: boolean;
  readonly createdAt?: string;
}

/**
 * 아티클을 **DB에 직접 넣는다.** HTTP로는 만들 수 없기 때문이다 — 아티클을 만드는 것은
 * 야간 배치(T-029)뿐이고 specs/04 표에 생성 오퍼레이션이 없다. 그 사실 자체가
 * "전자동 발행 금지"의 한 겹이므로 테스트가 우회 경로를 만들지 않는다.
 */
async function seed(options: SeedOptions): Promise<string> {
  const _id = new ObjectId();
  const withBody = options.withBody ?? options.status !== "candidate";
  await db.collection("articles").insertOne({
    _id,
    kind: "pattern",
    sourceRecordIds: [SOURCE_ID],
    title: options.title,
    slug: options.slug,
    status: options.status,
    editHistory: [],
    createdAt: new Date(options.createdAt ?? "2026-08-01T00:00:00.000Z"),
    ...(withBody ? { body: BODY } : {}),
    // published는 `ArticleSchema.refine`이 publishedAt을 요구한다 — 실제 저장 상태를 흉내 낸다.
    ...(options.status === "published"
      ? { publishedAt: new Date("2026-08-02T00:00:00.000Z") }
      : {}),
  });
  return _id.toHexString();
}

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function request(
  method: "GET" | "PATCH" | "POST",
  url: string,
  authorization: string | undefined,
  payload?: unknown,
): Promise<JsonResponse> {
  const response = await app.inject({
    method,
    url,
    ...(authorization === undefined ? {} : { headers: { authorization } }),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function items(body: Record<string, unknown>): Record<string, unknown>[] {
  return body["items"] as Record<string, unknown>[];
}

function ids(body: Record<string, unknown>): string[] {
  return items(body).map((item) => item["_id"] as string);
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body["error"] as Record<string, unknown> | undefined)?.["code"];
}

async function statusInDb(id: string): Promise<unknown> {
  const document = await db.collection("articles").findOne({ _id: new ObjectId(id) });
  return document?.["status"];
}

// ================================================================
// GET /v1/articles — 목록 기본값. 이 블록이 이 태스크의 방어선이다.
// ================================================================

describe("GET /v1/articles — 기본은 published만이다 (specs/04)", () => {
  /**
   * **가장 중요한 단언.**
   *
   * 관측 경로: candidate·draft·rejected·published를 한 컬렉션에 넣고 **status를 빼고** 조회한다.
   * 기대값은 "published인 그 아티클 하나"이며, id를 리터럴로 박을 수 없으므로 시드가 돌려준
   * 실제 id와 대조한다 — 좌변이 HTTP 응답, 우변이 DB에 넣은 사실이라 자기충족이 아니다.
   *
   * 뮤테이션: `ListArticlesQuery.status`의 `.default("published")`를 `.optional()`로 바꾸고
   * 라우트가 필터를 조건부로 걸면, candidate가 이 목록에 나타나 여기서 죽는다.
   */
  it("status를 주지 않으면 published만 나온다 — 미발행 초안이 새지 않는다", async () => {
    const candidate = await seed({ status: "candidate", title: "후보 아티클", slug: "c-1-aaaa" });
    const draft = await seed({ status: "draft", title: "초안 아티클", slug: "d-1-bbbb" });
    const rejected = await seed({ status: "rejected", title: "반려 아티클", slug: "r-1-cccc" });
    const published = await seed({ status: "published", title: "발행 아티클", slug: "p-1-dddd" });

    const response = await request("GET", "/v1/articles", ALPHA);

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([published]);
    expect(ids(response.body)).not.toContain(candidate);
    expect(ids(response.body)).not.toContain(draft);
    expect(ids(response.body)).not.toContain(rejected);
  });

  /**
   * **대조군.** 위 단언이 "컬렉션이 비어서 통과한 것"이 아님을 못박는다.
   * 같은 candidate가 status를 명시하면 실제로 보인다 — 즉 숨긴 것은 필터이지 데이터가 아니다.
   */
  it("status=candidate를 명시하면 후보 큐가 보인다", async () => {
    const candidate = await seed({ status: "candidate", title: "후보 아티클", slug: "c-2-aaaa" });
    await seed({ status: "published", title: "발행 아티클", slug: "p-2-dddd" });

    const response = await request("GET", "/v1/articles?status=candidate", ALPHA);

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([candidate]);
  });

  it("status=draft도 명시해야 보인다", async () => {
    const draft = await seed({ status: "draft", title: "초안 아티클", slug: "d-3-bbbb" });
    await seed({ status: "published", title: "발행 아티클", slug: "p-3-dddd" });

    const response = await request("GET", "/v1/articles?status=draft", ALPHA);

    expect(ids(response.body)).toEqual([draft]);
  });

  it("빈 결과에서도 status를 빠뜨린 조회가 전체를 돌려주지 않는다", async () => {
    await seed({ status: "candidate", title: "후보만 있다", slug: "c-4-aaaa" });

    const response = await request("GET", "/v1/articles", ALPHA);

    expect(ids(response.body)).toEqual([]);
    expect(response.body["nextCursor"]).toBeNull();
  });

  it("계약 밖 status는 조용히 무시되지 않고 400이다", async () => {
    await seed({ status: "candidate", title: "후보 아티클", slug: "c-5-aaaa" });

    const response = await request("GET", "/v1/articles?status=all", ALPHA);

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
  });

  /**
   * **목록에 본문을 싣지 않는다** (NFR-03, specs/04 "본문 없는 요약").
   * 시드한 published 아티클은 본문을 갖고 있으므로, 응답에 없다는 것은 라우트가 뺐다는 뜻이다.
   */
  it("목록 항목에 본문 계열 필드가 없다 (NFR-03)", async () => {
    await seed({ status: "published", title: "발행 아티클", slug: "p-6-dddd" });

    const response = await request("GET", "/v1/articles", ALPHA);
    const item = items(response.body)[0] ?? {};

    for (const field of ["body", "facts", "charts", "lintReport", "editHistory"]) {
      expect(Object.keys(item)).not.toContain(field);
    }
    // 대조군: 판단에 필요한 필드는 실려 있다 — 빈 객체를 보고 통과한 것이 아니다.
    expect(item["title"]).toBe("발행 아티클");
    expect(item["sourceRecordCount"]).toBe(1);
  });

  it("cursor로 다음 페이지를 넘긴다 — offset은 계약이 거부한다", async () => {
    const older = await seed({
      status: "published",
      title: "먼저 만든 아티클",
      slug: "p-7-old0",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const newer = await seed({
      status: "published",
      title: "나중 만든 아티클",
      slug: "p-7-new0",
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    const first = await request("GET", "/v1/articles?limit=1", ALPHA);
    expect(ids(first.body)).toEqual([newer]);
    const cursor = first.body["nextCursor"];
    expect(cursor).not.toBeNull();

    const second = await request(
      "GET",
      `/v1/articles?limit=1&cursor=${String(cursor)}`,
      ALPHA,
    );
    expect(ids(second.body)).toEqual([older]);
    expect(second.body["nextCursor"]).toBeNull();

    const offset = await request("GET", "/v1/articles?offset=1", ALPHA);
    expect(offset.status).toBe(400);
  });

  it("Bearer 없이는 401이다 — /v1 아래는 공개가 아니다", async () => {
    const response = await request("GET", "/v1/articles", undefined);
    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("UNAUTHORIZED");
  });
});

// ================================================================
// GET /v1/articles/:id
// ================================================================

describe("GET /v1/articles/:id", () => {
  it("단건 조회는 본문을 포함한다 (specs/04)", async () => {
    const id = await seed({ status: "published", title: "발행 아티클", slug: "g-1-dddd" });

    const response = await request("GET", `/v1/articles/${id}`, ALPHA);

    expect(response.status).toBe(200);
    expect(response.body["body"]).toBe(BODY);
    expect(response.body["_id"]).toBe(id);
    // 식별자가 hex 문자열로 낮춰졌는지 — 계약은 DB를 모른다(specs/02).
    expect(response.body["sourceRecordIds"]).toEqual([SOURCE_ID.toHexString()]);
  });

  /** specs/04 규약: `project` 크로스 **조회**는 허용이다. 아티클에는 소유 project 자체가 없다. */
  it("다른 project 키로도 조회된다 — 크로스 조회는 허용이다", async () => {
    const id = await seed({ status: "published", title: "발행 아티클", slug: "g-2-dddd" });

    const response = await request("GET", `/v1/articles/${id}`, BETA);

    expect(response.status).toBe(200);
  });

  it("없는 아티클은 404다", async () => {
    const response = await request("GET", "/v1/articles/0123456789abcdef01234567", ALPHA);
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe("ARTICLE_NOT_FOUND");
  });

  it("24자 hex가 아닌 id는 400이다", async () => {
    const response = await request("GET", "/v1/articles/nope", ALPHA);
    expect(response.status).toBe(400);
  });

  it("Bearer 없이는 401이다", async () => {
    const id = await seed({ status: "published", title: "발행 아티클", slug: "g-5-dddd" });
    expect((await request("GET", `/v1/articles/${id}`, undefined)).status).toBe(401);
  });
});

// ================================================================
// PATCH /v1/articles/:id — candidate·draft에서만
// ================================================================

describe("PATCH /v1/articles/:id", () => {
  it("draft를 편집하고 editHistory를 남긴다 (specs/08 §2)", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-1-bbbb" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, {
      body: "## 다시 쓴 본문\n2026-08-05 11:02의 로그를 넣었다.",
      title: "사람이 고친 제목",
    });

    expect(response.status).toBe(200);
    expect(response.body["title"]).toBe("사람이 고친 제목");
    expect(response.body["body"]).toBe("## 다시 쓴 본문\n2026-08-05 11:02의 로그를 넣었다.");

    // 편집 기록은 **서버가** 붙인다. 시각은 주입된 시계에서 나온다.
    const history = response.body["editHistory"] as { at: string; diffSummary: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]?.at).toBe(SERVER_NOW);
    expect(history[0]?.diffSummary).toBe("body, title 수정");
  });

  it("candidate도 편집할 수 있다 (specs/04: candidate·draft에서만 허용)", async () => {
    const id = await seed({ status: "candidate", title: "후보 아티클", slug: "e-2-aaaa" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, { status: "rejected" });

    expect(response.status).toBe(200);
    expect(response.body["status"]).toBe("rejected");
  });

  it("편집 기록은 누적된다 — 이전 항목을 덮지 않는다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-3-bbbb" });

    await request("PATCH", `/v1/articles/${id}`, ALPHA, { title: "첫 번째 수정본" });
    const second = await request("PATCH", `/v1/articles/${id}`, ALPHA, { title: "두 번째 수정본" });

    expect(second.body["editHistory"]).toHaveLength(2);
  });

  /**
   * **published 아티클은 편집 대상이 아니다** (specs/04).
   * 뮤테이션: 상태 게이트를 지우면 발행된 글이 조용히 바뀌고 여기서 죽는다.
   */
  it("published 아티클 편집은 409다 — 독자가 본 것과 저장된 것이 갈라진다", async () => {
    const id = await seed({ status: "published", title: "발행 아티클", slug: "e-4-dddd" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, { title: "몰래 고친 제목" });

    expect(response.status).toBe(409);
    expect(errorCode(response.body)).toBe("ARTICLE_NOT_EDITABLE");

    // 실제로 바뀌지 않았는지 DB에서 확인한다 — 상태 코드만 보면 부분 적용을 놓친다.
    const document = await db.collection("articles").findOne({ _id: new ObjectId(id) });
    expect(document?.["title"]).toBe("발행 아티클");
  });

  it("rejected 아티클 편집도 409다 — 사람이 내린 판단을 지울 수 없다", async () => {
    const id = await seed({ status: "rejected", title: "반려 아티클", slug: "e-5-cccc" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, { title: "되살린 제목" });

    expect(response.status).toBe(409);
  });

  /**
   * **specs/04: `publishedAt`은 서버가 찍는다.** 편집 경로도 그 규칙 밖이 아니다 —
   * 여기가 열리면 PATCH가 두 번째 발행 경로가 된다.
   */
  it("바디에 publishedAt이 오면 400이다 (전용 코드로 알린다)", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-6-bbbb" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, {
      body: "본문",
      publishedAt: CLIENT_FORGED_AT,
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("PUBLISHED_AT_IS_SERVER_OWNED");
    expect(await statusInDb(id)).toBe("draft");
  });

  it("바디에 project가 오면 조용히 무시하지 않고 400이다 (confused deputy)", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-7-bbbb" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, {
      body: "본문",
      project: "bizcare-web",
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("PROJECT_NOT_ALLOWED_IN_BODY");
  });

  /** PATCH로 발행하는 우회로가 없어야 한다. 계약이 먼저 막고, 막혔다는 것을 여기서 관측한다. */
  it("status:published로 발행할 수 없다 — 발행은 별도 오퍼레이션이다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-8-bbbb" });

    const response = await request("PATCH", `/v1/articles/${id}`, ALPHA, { status: "published" });

    expect(response.status).toBe(400);
    expect(await statusInDb(id)).toBe("draft");
  });

  it("빈 패치는 400이다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-9-bbbb" });
    expect((await request("PATCH", `/v1/articles/${id}`, ALPHA, {})).status).toBe(400);
  });

  it("없는 아티클은 404다", async () => {
    const response = await request(
      "PATCH",
      "/v1/articles/0123456789abcdef01234567",
      ALPHA,
      { title: "제목을 고쳐 본다" },
    );
    expect(response.status).toBe(404);
  });

  it("Bearer 없이는 401이다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "e-a-bbbb" });
    const response = await request("PATCH", `/v1/articles/${id}`, undefined, { title: "제목" });
    expect(response.status).toBe(401);
  });
});

// ================================================================
// POST /v1/articles/:id/publish — 발행 시각은 서버가 찍는다
// ================================================================

describe("POST /v1/articles/:id/publish", () => {
  /**
   * **specs/04의 핵심 문장을 관측한다**: "`publishedAt`은 서버가 찍는다".
   *
   * 관측 경로: 시계를 `SERVER_NOW`로 주입하고 바디 없이 발행한 뒤, 응답과 DB의 `publishedAt`이
   * 그 시각인지 본다. 좌변은 HTTP 응답, 우변은 테스트가 주입한 시계라 자기충족이 아니다 —
   * 라우트가 `deps.now()` 대신 다른 값을 쓰면 여기서 죽는다.
   */
  it("발행하면 서버 시계로 publishedAt을 찍는다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-1-bbbb" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA);

    expect(response.status).toBe(200);
    expect(response.body["status"]).toBe("published");
    expect(response.body["publishedAt"]).toBe(SERVER_NOW);

    const document = await db.collection("articles").findOne({ _id: new ObjectId(id) });
    expect((document?.["publishedAt"] as Date).toISOString()).toBe(SERVER_NOW);
  });

  /**
   * **클라이언트가 발행 시각을 보내면 400이다** (specs/04).
   * 이 한 겹이 없으면 배치가 세 겹으로 막은 자동 발행 금지가 HTTP 표면에서 뚫린다.
   * 상태 코드만 보지 않고 **DB가 draft로 남았는지**까지 본다 — 400을 내면서 쓰는 구현도 가능하다.
   */
  it("바디에 publishedAt이 오면 400이고 발행되지 않는다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-2-bbbb" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA, {
      publishedAt: CLIENT_FORGED_AT,
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("PUBLISHED_AT_IS_SERVER_OWNED");
    expect(await statusInDb(id)).toBe("draft");
  });

  it("바디에 아무 키나 오면 400이다 — 발행 요청이 전달할 정보는 경로에 이미 있다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-3-bbbb" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA, {
      status: "published",
    });

    expect(response.status).toBe(400);
    expect(await statusInDb(id)).toBe("draft");
  });

  it("바디의 project도 400이다 (confused deputy)", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-4-bbbb" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA, {
      project: "bizcare-web",
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("PROJECT_NOT_ALLOWED_IN_BODY");
  });

  /**
   * **본문 없는 candidate는 발행되지 않는다** (specs/08 §0-5·§4).
   * 상태 게이트와 `ArticleSchema.refine`이 이중으로 막는다.
   */
  it("candidate 발행은 409다 — 아무도 쓰지 않은 글은 내보내지 않는다", async () => {
    const id = await seed({
      status: "candidate",
      title: "후보 아티클",
      slug: "b-5-aaaa",
      withBody: false,
    });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA);

    expect(response.status).toBe(409);
    expect(errorCode(response.body)).toBe("ARTICLE_NOT_PUBLISHABLE");
    expect(await statusInDb(id)).toBe("candidate");
  });

  it("rejected 발행도 409다", async () => {
    const id = await seed({ status: "rejected", title: "반려 아티클", slug: "b-6-cccc" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA);

    expect(response.status).toBe(409);
    expect(await statusInDb(id)).toBe("rejected");
  });

  it("이미 발행된 아티클을 다시 발행하면 409다 — publishedAt이 덮이지 않는다", async () => {
    const id = await seed({ status: "published", title: "발행 아티클", slug: "b-7-dddd" });

    const response = await request("POST", `/v1/articles/${id}/publish`, ALPHA);

    expect(response.status).toBe(409);
    const document = await db.collection("articles").findOne({ _id: new ObjectId(id) });
    expect((document?.["publishedAt"] as Date).toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("발행 후 목록 기본값에 나타난다 — 두 오퍼레이션이 같은 상태를 본다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-8-bbbb" });

    expect(ids((await request("GET", "/v1/articles", ALPHA)).body)).toEqual([]);
    await request("POST", `/v1/articles/${id}/publish`, ALPHA);
    expect(ids((await request("GET", "/v1/articles", ALPHA)).body)).toEqual([id]);
  });

  it("없는 아티클은 404다", async () => {
    const response = await request(
      "POST",
      "/v1/articles/0123456789abcdef01234567/publish",
      ALPHA,
    );
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe("ARTICLE_NOT_FOUND");
  });

  it("Bearer 없이는 401이다", async () => {
    const id = await seed({ status: "draft", title: "초안 아티클", slug: "b-9-bbbb" });
    expect((await request("POST", `/v1/articles/${id}/publish`, undefined)).status).toBe(401);
  });
});
