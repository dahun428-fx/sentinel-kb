import { describe, expect, it } from "vitest";

import { OPENAPI_VERSION, buildOpenApiDocument } from "./openapi.js";

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"] as const;

/**
 * specs/04 표의 12개 오퍼레이션 (9개 path item에 걸쳐 있다).
 *
 * **8 → 12로 늘어난 것은 스펙이 바뀐 결과이지 테스트를 느슨하게 고친 것이 아니다.**
 * `1bab157 Spec(04): 아티클 오퍼레이션 4건 추가`가 표에 `/v1/articles` 네 줄을 등재했고,
 * 그 커밋의 블록쿼트가 왜 스펙을 먼저 고쳐야 했는지를 적어 뒀다:
 * > T-036의 양방향 드리프트 가드가 `pnpm verify` 안에서 돌아 라우트만 추가하는 우회가 막혀 있었고,
 * > CLAUDE.md가 "스펙 없는 신규 API 추가"를 금지하므로 **스펙을 먼저 고치는 것이 규약상 유일한 경로**다.
 *
 * 이 목록은 여전히 **표를 옮겨 적은 것**이다. 아래 "표에 없는 오퍼레이션은 등록하지 않는다"가
 * 길이를 대조하므로, 여기 한 줄을 더하는 것은 표에 한 줄이 늘었다는 주장과 같다.
 */
const EXPECTED_OPERATIONS = [
  ["/v1/records", "post"],
  ["/v1/records", "get"],
  ["/v1/records/{id}", "get"],
  ["/v1/records/{id}", "patch"],
  ["/v1/search", "post"],
  ["/v1/answer", "post"],
  ["/v1/feedback", "post"],
  ["/v1/articles", "get"],
  ["/v1/articles/{id}", "get"],
  ["/v1/articles/{id}", "patch"],
  ["/v1/articles/{id}/publish", "post"],
  ["/health", "get"],
] as const;

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument();

  it("OpenAPI 3.1.0 문서다", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(OPENAPI_VERSION).toBe("3.1.0");
  });

  it("필수 최상위 키를 갖는다", () => {
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(doc.paths).toBeDefined();
    expect(doc.components).toBeDefined();
  });

  it("JSON으로 직렬화된다", () => {
    const round: unknown = JSON.parse(JSON.stringify(doc));
    expect(round).toMatchObject({ openapi: "3.1.0" });
  });

  it.each(EXPECTED_OPERATIONS)("specs/04의 %s %s를 등록한다", (path, method) => {
    expect(doc.paths?.[path]?.[method]).toBeDefined();
  });

  it("specs/04 표에 없는 오퍼레이션은 등록하지 않는다", () => {
    const operations = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      HTTP_METHODS.filter((method) => item[method] !== undefined).map(
        (method) => `${method} ${path}`,
      ),
    );
    expect(operations).toHaveLength(EXPECTED_OPERATIONS.length);
  });

  it("모든 오퍼레이션이 고유한 operationId를 갖는다", () => {
    const operationIds = Object.values(doc.paths ?? {}).flatMap((item) =>
      HTTP_METHODS.map((method) => item[method]?.operationId).filter(
        (id): id is string => id !== undefined,
      ),
    );
    expect(operationIds).toHaveLength(EXPECTED_OPERATIONS.length);
    expect(new Set(operationIds).size).toBe(EXPECTED_OPERATIONS.length);
  });

  it("Bearer 인증 스킴을 등록한다 (NFR-04)", () => {
    expect(doc.components?.securitySchemes?.["bearerAuth"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("/v1 경로는 Bearer 인증을 요구하고 /health는 요구하지 않는다", () => {
    expect(doc.paths?.["/v1/search"]?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths?.["/health"]?.get?.security).toEqual([]);
  });

  it("요청·응답 페이로드 스키마를 컴포넌트로 등록한다", () => {
    const schemas = Object.keys(doc.components?.schemas ?? {});
    expect(schemas).toEqual(
      expect.arrayContaining([
        "Record",
        "CreateRecordInput",
        "PatchRecordInput",
        "ListRecordsResponse",
        "SearchRequest",
        "SearchResponse",
        "AnswerRequest",
        "AnswerResponse",
        "FeedbackRequest",
        // B-1. specs/04 표에 아티클 4건이 등재되며 `Article`이 저장 스키마이자 응답 페이로드가 됐다.
        "Article",
        "ListArticlesResponse",
        "PatchArticleInput",
        "PublishArticleInput",
        "HealthResponse",
        "ApiError",
      ]),
    );
  });

  /**
   * **목록 응답에 본문이 실리지 않는다** — specs/04 표의 "본문 없는 요약"을 문서에서 잠근다.
   * 이 단언의 좌변은 생성된 OpenAPI 문서의 실제 프로퍼티 집합이라,
   * `ArticleSummary`에 `body`를 끼워 넣으면 여기서 먼저 빨개진다(NFR-03).
   */
  it("ListArticlesResponse 항목에 본문 계열 필드가 없다 (NFR-03)", () => {
    /** 문서를 직렬화해서 본다 — `openapi3-ts` 타입은 $ref 갈래가 섞여 있어 좁히기가 요점이 아니다. */
    interface JsonSchemaNode {
      properties?: Record<string, JsonSchemaNode>;
      items?: JsonSchemaNode;
    }
    const schemas = (
      JSON.parse(JSON.stringify(doc)) as {
        components?: { schemas?: Record<string, JsonSchemaNode> };
      }
    ).components?.schemas;
    const properties = Object.keys(
      schemas?.["ListArticlesResponse"]?.properties?.["items"]?.items?.properties ?? {},
    );

    expect(properties).not.toContain("body");
    expect(properties).not.toContain("facts");
    expect(properties).not.toContain("charts");
    expect(properties).not.toContain("lintReport");
    expect(properties).not.toContain("editHistory");
    // 대조군: 판단에 필요한 필드는 실제로 있다 — 위 단언이 빈 객체를 보고 통과한 것이 아니다.
    expect(properties).toContain("title");
    expect(properties).toContain("status");
  });

  /**
   * 등록만 하고 경로에서 원본 스키마를 쓰면 본문이 인라인되고 components는 죽는다.
   * 모든 컴포넌트가 실제로 $ref되는지 확인해 그 회귀를 막는다.
   */
  it("등록한 컴포넌트는 모두 경로에서 $ref로 참조된다", () => {
    const refs = new Set(
      Array.from(
        JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g),
        (match) => match[1],
      ),
    );
    const unused = Object.keys(doc.components?.schemas ?? {}).filter(
      (name) => !refs.has(name),
    );
    expect(unused).toEqual([]);
  });

  it("응답 본문은 인라인이 아니라 $ref로 표현된다", () => {
    expect(
      doc.paths?.["/v1/search"]?.post?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema,
    ).toEqual({ $ref: "#/components/schemas/SearchResponse" });
  });

  it("Record는 type으로 갈라지는 판별 유니온으로 표현된다", () => {
    expect(doc.components?.schemas?.["Record"]).toHaveProperty("oneOf");
  });
});
