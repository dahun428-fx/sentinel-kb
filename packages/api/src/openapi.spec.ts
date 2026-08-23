/**
 * T-036. `/v1/openapi.json` 서빙 + **스펙-코드 드리프트 가드**.
 *
 * 이 파일의 무게중심은 라우트 스모크가 아니라 아래 "드리프트 가드" 블록이다.
 * 가드가 실제로 무언가를 잡는다는 것을 보이기 위해 **일부러 어긋난 입력**을 넣어
 * 실패를 확인하는 케이스를 양방향으로 둔다 — 가드가 항상 통과하기만 하면
 * 그 가드는 있으나 마나이고, 그 사실은 가드가 처음 필요해지는 날에야 드러난다.
 *
 * 단위 테스트다(`pnpm test` 경로). Mongo에 붙지 않는 이유는 라우트 **등록**이
 * DB와 무관하기 때문이고, 그래야 이 가드가 시크릿 없는 CI에서도 항상 돈다.
 */
import { buildOpenApiDocument } from "@sentinel/contracts/openapi";
import Fastify from "fastify";
import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
// T-037이 `parseApiKeys`를 `@sentinel/core`로 승격했다(인증 복제 회수).
import { parseApiKeys } from "@sentinel/core";
import {
  diffOperations,
  documentedOperations,
  normalizePath,
  PENDING_OPERATIONS,
  routeKey,
  trackRoutes,
  UNDOCUMENTED_ROUTES,
  type RouteRef,
} from "./openapi.js";

/**
 * 라우트 등록은 DB를 건드리지 않는다 — `recordsCollection(db)`가 `db.collection()`을
 * 부르는 것이 전부다. 그 한 메서드만 있는 스텁을 쓴다.
 * `Db` 전체를 흉내 낼 수 없으므로 `unknown`을 거쳐 좁힌다(`any` 대신).
 */
const DB_STUB = { collection: () => ({}) } as unknown as Db;

const API_KEYS = parseApiKeys("key-alpha:sentinel-kb");
const AUTH = { authorization: "Bearer key-alpha" };

/**
 * **retriever를 반드시 주입한다.** `/v1/search`는 `createApp`에서 조건부로 등록되므로
 * 주입하지 않으면 문서가 약속한 라우트가 실재하지 않고, 드리프트 가드가 그것을
 * "미구현"으로 보고한다. 프로덕션 컴포지션 루트(`server.ts`)는 **항상** 주입하므로
 * 여기서도 그 배선을 재현해야 가드가 운영 표면을 판정한다.
 *
 * (이 사실 자체가 통합에서 드러난 설계 지점이다 — 문서화된 API 표면이 런타임 배선에
 *  의존한다. `server.ts` 배선을 검증하는 테스트는 아직 없다: T-012 G5 지적.)
 */
const RETRIEVER_STUB = {
  retrieve: async () => ({
    hits: [],
    maxVectorScore: null,
    vectorCandidateCount: 0,
    textCandidateCount: 0,
  }),
} as unknown as NonNullable<Parameters<typeof createApp>[0]["retriever"]>;

/**
 * **chatModel도 반드시 주입한다.** `/v1/answer`는 `createApp`에서 `retriever`와 **함께**
 * 있을 때만 등록되므로(생성은 검색 없이는 근거가 없다), 위 `RETRIEVER_STUB` 주석과 같은
 * 이유로 여기서도 배선을 재현해야 가드가 문서화된 API 표면 전체를 판정한다.
 *
 * ⚠️ 다만 `server.ts`는 아직 이 값을 넘기지 못한다 — 실 provider가 없기 때문이다(T-018 D-2).
 * 즉 **이 가드가 보는 표면과 운영 표면이 지금은 다르다.** 가드가 초록인데 프로덕션에는
 * `/v1/answer`가 없다. `server.ts` 배선을 검증하는 테스트가 없다는 T-012 G5 지적이
 * 여기서 실제 간극으로 나타난 것이라, T-019 Findings에 인계했다.
 */
const CHAT_MODEL_STUB = {
  model: "openapi-spec-stub",
  complete: () => Promise.resolve({ text: "…", model: "openapi-spec-stub", stopReason: "end_turn" }),
} as unknown as NonNullable<Parameters<typeof createApp>[0]["chatModel"]>;

function makeApp() {
  return createApp({
    db: DB_STUB,
    apiKeys: API_KEYS,
    sanitizeOptions: { maskEmail: false, maxInputChars: 65_536 },
    embeddingVersion: 7,
    version: "0.0.1-test",
    retriever: RETRIEVER_STUB,
    chatModel: CHAT_MODEL_STUB,
  });
}

// ---------------------------------------------------------------- 서빙

describe("GET /v1/openapi.json", () => {
  it("200과 유효한 OpenAPI 3.1 문서를 돌려준다", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/openapi.json",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body: unknown = response.json();
    expect(body).toMatchObject({ openapi: "3.1.0" });
    expect(body).toHaveProperty("info.title");
    expect(body).toHaveProperty("paths");
    expect(body).toHaveProperty("components.schemas");
    await app.close();
  });

  /**
   * **수기 사본이 아님을 보장한다**(specs/04:29 "수기 작성 금지").
   * 응답이 contracts 생성 결과와 한 글자도 다르지 않아야 한다 — 필드를 하나라도
   * 덧붙이거나 걸러내면 여기서 걸린다.
   */
  it("응답이 packages/contracts의 생성 결과와 동일하다", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/openapi.json",
      headers: AUTH,
    });

    const expected: unknown = JSON.parse(JSON.stringify(buildOpenApiDocument()));
    expect(response.json()).toEqual(expected);
    await app.close();
  });

  /**
   * 인증 정책 결정(근거는 `openapi.ts`의 `registerOpenApiRoute` 주석):
   * `/v1` 아래이므로 Bearer를 요구한다. `/health`는 `/v1` **밖**이라서 공개다.
   */
  it("Bearer 없이는 401이다 — /v1 경로는 공개가 아니다", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "GET", url: "/v1/openapi.json" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await app.close();
  });

  it("/health는 반대로 인증 없이 열려 있다 (대조군)", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------- 드리프트 가드 (본체)

describe("드리프트 가드", () => {
  it("등록된 오퍼레이션과 실제 라우트가 정확히 일치한다", () => {
    const app = makeApp();
    const report = diffOperations(
      documentedOperations(buildOpenApiDocument()),
      app.registeredRoutes,
    );

    // 실패 시 무엇이 어긋났는지 메시지에 그대로 나오도록 객체째 비교한다.
    expect(report).toEqual({
      documentedButNotRouted: [],
      routedButNotDocumented: [],
      stalePending: [],
    });
  });

  /**
   * **유예 목록이 비었다는 사실 자체를 잠근다.**
   *
   * 이 테스트는 원래 "유예를 끄면 아직 라우트가 없는 오퍼레이션이 드러난다"였고 기댓값이
   * `["POST /v1/answer"]`였다. T-019가 그 라우트를 세웠으므로 유예 대상이 하나도 남지 않았다 —
   * `PENDING_OPERATIONS`가 스스로 규정한 대로, 라우트가 생기면 그 줄을 지워야만 초록이 되고
   * (`stalePending`), 지운 결과가 이 단언이다. 기댓값을 느슨하게 고친 것이 아니라
   * **유예가 사라졌다는 사실을 그대로 옮겨 적은 것**이다.
   *
   * 유예 없이도 양방향이 일치한다는 것은 곧 문서와 라우트가 **유예에 기대지 않고** 맞는다는
   * 뜻이다. 새 오퍼레이션이 문서에만 등재되면 여기가 가장 먼저 빨개진다.
   */
  it("유예 없이도 문서와 라우트가 일치한다 — 유예 목록이 비었다", () => {
    const app = makeApp();
    const report = diffOperations(
      documentedOperations(buildOpenApiDocument()),
      app.registeredRoutes,
      { pending: [] },
    );

    expect(PENDING_OPERATIONS).toEqual([]);
    expect(report.documentedButNotRouted).toEqual([]);
  });

  /**
   * **유예 목록의 자정 장치.** 유예해 둔 오퍼레이션의 라우트가 생기면 가드가 실패해
   * 그 줄을 지우도록 강제한다. 이게 없으면 유예 목록은 한 번 늘어난 뒤 영원히 남고,
   * 그 항목들은 가드에서 조용히 빠진 채 드리프트를 통과시킨다.
   */
  it("유예해 둔 오퍼레이션의 라우트가 생기면 유예 항목이 stale로 잡힌다", () => {
    const documented: RouteRef[] = [{ method: "POST", path: "/v1/search" }];
    const routed: RouteRef[] = [{ method: "POST", path: "/v1/search" }];

    const report = diffOperations(documented, routed, {
      pending: [{ key: "POST /v1/search", task: "T-012" }],
    });

    expect(report.documentedButNotRouted).toEqual([]);
    expect(report.stalePending).toEqual([
      "POST /v1/search (T-012 완료됨 — PENDING_OPERATIONS에서 지워라)",
    ]);
  });

  it("specs/04 표의 오퍼레이션을 모두 라우트로 갖는다", () => {
    const app = makeApp();
    const routed = new Set(app.registeredRoutes.map(routeKey));

    // 기대값은 리터럴이다 — 구현에서 끌어오면 아무것도 검증하지 못한다.
    for (const key of [
      "POST /v1/records",
      "GET /v1/records",
      "GET /v1/records/{id}",
      "PATCH /v1/records/{id}",
      // T-019. 유예 목록에서 지운 오퍼레이션이 **실제로 라우트로 있는지**를 여기서 다시 본다 —
      // 유예를 지우고 라우트를 안 세우는 실수는 `documentedButNotRouted`가 잡지만,
      // 이 리터럴 목록은 가드 기계가 통째로 고장 나도 남는 마지막 단언이다.
      "POST /v1/answer",
      // B-1. specs/04 표에 아티클 4건이 등재됐다(`1bab157`). 스펙이 늘어난 결과이며,
      // `UNDOCUMENTED_ROUTES`로 우회하지 않고 contracts에 오퍼레이션을 등록해 맞췄다.
      "GET /v1/articles",
      "GET /v1/articles/{id}",
      "PATCH /v1/articles/{id}",
      "POST /v1/articles/{id}/publish",
      "GET /health",
    ]) {
      expect(routed).toContain(key);
    }
  });

  /**
   * **우회로가 열리지 않았음을 잠근다.** 아티클 라우트 4개를 `UNDOCUMENTED_ROUTES`에 넣는 것은
   * 드리프트 가드를 통과하는 가장 싼 길이고, 명시적으로 금지된 경로다(`openapi.ts` 주석).
   * 목록이 `/v1/openapi.json` 한 줄로 남아 있는지 여기서 본다.
   */
  it("아티클 라우트는 allowlist가 아니라 문서 등록으로 통과한다", () => {
    expect(UNDOCUMENTED_ROUTES).toEqual(["GET /v1/openapi.json"]);

    const documented = new Set(documentedOperations(buildOpenApiDocument()).map(routeKey));
    expect(documented).toContain("GET /v1/articles");
    expect(documented).toContain("POST /v1/articles/{id}/publish");
  });

  /**
   * **일부러 어긋나게 만든다 — 방향 1.**
   * openapi에는 있는데 라우트가 없는 오퍼레이션(예: 아직 구현되지 않은 `/v1/search`)을
   * 실제 앱의 라우트 목록에 대고 대조하면 반드시 걸려야 한다.
   */
  it("openapi에 등록됐는데 라우트가 없으면 잡는다", () => {
    const app = makeApp();
    const documented = [
      ...documentedOperations(buildOpenApiDocument()),
      // 유예 목록에 없는, 순수하게 새로 어긋난 오퍼레이션.
      { method: "PUT", path: "/v1/records/{id}" },
    ];

    const report = diffOperations(documented, app.registeredRoutes);

    expect(report.documentedButNotRouted).toEqual(["PUT /v1/records/{id}"]);
    expect(report.routedButNotDocumented).toEqual([]);
  });

  /**
   * **일부러 어긋나게 만든다 — 방향 2.**
   * 문서에 없는 라우트를 진짜 Fastify 인스턴스에 등록하고, `trackRoutes`가 그것을
   * 실제로 주워 오는지까지 함께 확인한다. 손으로 만든 배열만 비교하면
   * 수집 단계의 버그는 영원히 안 보인다.
   */
  it("라우트가 있는데 openapi에 없으면 잡는다", () => {
    const app = Fastify({ logger: false });
    const routes = trackRoutes(app);
    app.get("/v1/records", async () => ({}));
    app.delete("/v1/records/:id", async () => ({})); // 계약에 없는 엔드포인트

    const report = diffOperations(documentedOperations(buildOpenApiDocument()), routes);

    expect(report.routedButNotDocumented).toEqual(["DELETE /v1/records/{id}"]);
  });

  it("allowlist에 있는 라우트는 문서에 없어도 통과한다", () => {
    const documented: RouteRef[] = [];
    const routed: RouteRef[] = [{ method: "GET", path: "/v1/openapi.json" }];

    expect(diffOperations(documented, routed).routedButNotDocumented).toEqual([]);
    // allowlist를 비우면 같은 입력이 걸린다 — 통과가 allowlist 덕분임을 못박는다.
    expect(
      diffOperations(documented, routed, { allowlist: [] }).routedButNotDocumented,
    ).toEqual(["GET /v1/openapi.json"]);
  });

  /**
   * 유예는 **문서에 실재하는 오퍼레이션에만** 걸 수 있다.
   * 이 단언이 없으면 `PENDING_OPERATIONS`에 아무 문자열이나 넣어 가드를 넓힐 수 있고,
   * 그렇게 들어간 항목은 `stalePending`으로도 영영 잡히지 않는다 —
   * 대응하는 라우트가 생길 일이 없으니 자정 장치가 작동하지 않기 때문이다.
   */
  it("PENDING_OPERATIONS 항목은 모두 openapi에 실재하는 오퍼레이션이다", () => {
    const documented = new Set(documentedOperations(buildOpenApiDocument()).map(routeKey));

    for (const entry of PENDING_OPERATIONS) {
      expect(documented).toContain(entry.key);
    }
  });

  it("서빙 라우트 자신은 allowlist로만 통과한다 — 문서에는 없다", () => {
    const documentedKeys = documentedOperations(buildOpenApiDocument()).map(routeKey);
    expect(documentedKeys).not.toContain("GET /v1/openapi.json");
  });
});

// ---------------------------------------------------------------- 대조 기계 자체

describe("documentedOperations", () => {
  it("path item 레벨 키를 오퍼레이션으로 오인하지 않는다", () => {
    const operations = documentedOperations({
      paths: {
        "/a": { get: {}, summary: "설명일 뿐 오퍼레이션이 아니다", servers: [] },
      },
    });

    expect(operations).toEqual([{ method: "GET", path: "/a" }]);
  });

  /**
   * 문서 형상이 깨졌을 때 **조용히 통과하지 않는다.** 빈 배열을 돌려주면
   * 감시가 필요한 바로 그 순간 감시가 꺼진다.
   */
  it.each([
    ["null", null],
    ["paths 없음", {}],
    ["paths가 객체가 아님", { paths: "nope" }],
  ])("문서 형상이 깨지면 던진다: %s", (_label, document) => {
    expect(() => documentedOperations(document)).toThrow(/paths/);
  });
});

describe("normalizePath", () => {
  it("Fastify의 :param을 OpenAPI의 {param}으로 바꾼다", () => {
    expect(normalizePath("/v1/records/:id")).toBe("/v1/records/{id}");
    expect(normalizePath("/a/:x/b/:y_2")).toBe("/a/{x}/b/{y_2}");
  });

  it("파라미터가 없으면 그대로 둔다", () => {
    expect(normalizePath("/v1/openapi.json")).toBe("/v1/openapi.json");
  });
});

describe("trackRoutes", () => {
  /**
   * Fastify는 `exposeHeadRoutes` 기본값으로 모든 GET에 HEAD를 자동으로 붙인다.
   * 그것을 인벤토리에 담으면 GET 라우트 수만큼 영구 오탐이 생겨 가드가 첫날에 꺼진다.
   */
  it("자동 생성된 HEAD는 담지 않는다", () => {
    const app = Fastify({ logger: false });
    const routes = trackRoutes(app);
    app.get("/a", async () => ({}));

    expect(routes).toEqual([{ method: "GET", path: "/a" }]);
  });

  it("훅을 단 뒤에 등록된 라우트만 수집한다", () => {
    const app = Fastify({ logger: false });
    app.get("/before", async () => ({}));
    const routes = trackRoutes(app);
    app.get("/after", async () => ({}));

    expect(routes.map(routeKey)).toEqual(["GET /after"]);
  });
});
