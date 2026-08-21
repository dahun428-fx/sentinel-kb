import { describe, expect, it } from "vitest";

import * as contracts from "./index.js";
import { CreateRecordInput, SearchRequest } from "./index.js";

describe("@sentinel/contracts smoke", () => {
  it("유효한 incident 입력을 파싱한다", () => {
    const result = CreateRecordInput.safeParse({
      type: "incident",
      title: "MCP 서버 504 게이트웨이 타임아웃",
      symptom: "search_knowledge 호출이 30초 후 504로 실패한다",
      resolution: "nginx proxy_read_timeout을 120s로 올리고 keepalive 설정 추가",
    });
    expect(result.success).toBe(true);
  });

  it("잘못된 입력은 거부한다", () => {
    const result = SearchRequest.safeParse({ query: "a" });
    expect(result.success).toBe(false);
  });

  /**
   * 공개 표면을 **정확히** 잠근다.
   *
   * `arrayContaining`이었을 때는 누락만 잡고 추가는 못 잡았다 — 누가
   * `export * from "./spec-helpers.js"`(테스트 전용 헬퍼)를 넣어도 그린이었다.
   * 배럴은 계약이므로 이름이 사라지는 것도, 의도 없이 늘어나는 것도 실패여야 한다.
   *
   * `buildOpenApiDocument`/`OPENAPI_VERSION`은 여기 없다 — openapi 모듈은 zod를
   * 전역 패치하므로 배럴에서 빠지고 `@sentinel/contracts/openapi` 서브패스로만 노출된다.
   */
  it("공개 스키마를 배럴에서 정확히 이만큼만 re-export한다", () => {
    expect(Object.keys(contracts).sort()).toEqual(
      [
        // common.ts
        "Severity",
        "RecordType",
        "RecordStatus",
        "SanitizeFlag",
        "RelationType",
        "ChunkSection",
        "ObjectIdString",
        "Relation",
        // record.ts
        "DivergenceContext",
        "IncidentInput",
        "DivergenceInput",
        "CreateRecordInput",
        "PatchRecordInput",
        "IncidentRecord",
        "DivergenceRecord",
        "RecordSchema",
        "RecordSummary",
        // chunk.ts
        "ChunkMeta",
        "ChunkSchema",
        // feedback.ts
        "FeedbackSchema",
        "FeedbackRequest",
        // eval-case.ts
        "EvalCaseSchema",
        // api.ts
        "RecordIdParam",
        "ListRecordsQuery",
        "CursorPage",
        "ListRecordsResponse",
        "SearchRequest",
        "SearchHit",
        "SearchResponse",
        "AnswerRequest",
        "Citation",
        "AnswerResponse",
        "HealthResponse",
        "ApiError",
      ].sort(),
    );
  });

  /** B-6: 배럴 한 줄 import가 문서 생성기와 zod 전역 패치를 끌고 오면 안 된다. */
  it("openapi 모듈은 배럴에 없다", () => {
    expect(Object.keys(contracts)).not.toContain("buildOpenApiDocument");
    expect(Object.keys(contracts)).not.toContain("OPENAPI_VERSION");
  });
});
