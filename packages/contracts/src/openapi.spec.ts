import { describe, expect, it } from "vitest";

import { OPENAPI_VERSION, buildOpenApiDocument } from "./openapi.js";

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"] as const;

/** specs/04 표의 8개 오퍼레이션 (6개 path item에 걸쳐 있다) */
const EXPECTED_OPERATIONS = [
  ["/v1/records", "post"],
  ["/v1/records", "get"],
  ["/v1/records/{id}", "get"],
  ["/v1/records/{id}", "patch"],
  ["/v1/search", "post"],
  ["/v1/answer", "post"],
  ["/v1/feedback", "post"],
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
        "HealthResponse",
        "ApiError",
      ]),
    );
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
