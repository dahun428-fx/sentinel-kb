import { describe, expect, it } from "vitest";

import {
  AnswerRequest,
  AnswerResponse,
  ApiError,
  CursorPage,
  ListRecordsQuery,
  ListRecordsResponse,
  SearchHit,
  SearchRequest,
  SearchResponse,
  HealthResponse,
} from "./api.js";
import { without } from "./spec-helpers.js";

describe("ListRecordsQuery", () => {
  it("limit 기본값은 20이다", () => {
    expect(ListRecordsQuery.parse({}).limit).toBe(20);
  });

  it("쿼리스트링의 문자열 limit을 숫자로 강제 변환한다", () => {
    expect(ListRecordsQuery.parse({ limit: "50" }).limit).toBe(50);
  });

  it.each([0, -1, 101, 1.5])("limit %s는 거부한다", (limit) => {
    expect(ListRecordsQuery.safeParse({ limit }).success).toBe(false);
  });

  it("cursor 페이지네이션만 지원한다 — offset은 거부한다", () => {
    expect(ListRecordsQuery.safeParse({ offset: 20 }).success).toBe(false);
    expect(ListRecordsQuery.safeParse({ cursor: "abc" }).success).toBe(true);
  });
});

describe("CursorPage", () => {
  it("마지막 페이지의 nextCursor는 null이다", () => {
    const page = CursorPage(SearchHit.pick({ recordId: true }));
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("SearchRequest", () => {
  it("limit 기본값은 5다", () => {
    expect(SearchRequest.parse({ query: "504 타임아웃" }).limit).toBe(5);
  });

  it("2자 미만 query는 거부한다", () => {
    expect(SearchRequest.safeParse({ query: "a" }).success).toBe(false);
  });

  it("limit 상한은 20이다", () => {
    expect(SearchRequest.safeParse({ query: "타임아웃", limit: 21 }).success).toBe(
      false,
    );
  });
});

describe("SearchResponse", () => {
  const hit = {
    recordId: "0123456789abcdef01234567",
    title: "MCP 서버 504",
    summary: "nginx 타임아웃이 원인이었다.",
    section: "resolution",
    score: 0.82,
    type: "incident",
    project: "sentinel-kb",
  };

  it("유효한 결과를 파싱하고 flags 기본값을 채운다", () => {
    const parsed = SearchResponse.parse({ results: [hit] });
    expect(parsed.results[0]?.flags).toEqual([]);
  });

  it("section은 정의된 청크 섹션만 허용한다", () => {
    expect(
      SearchResponse.safeParse({ results: [{ ...hit, section: "body" }] }).success,
    ).toBe(false);
  });
});

describe("AnswerRequest", () => {
  it("stream 기본값은 false다 — SSE는 명시적 옵트인이다 (specs/04:13)", () => {
    expect(AnswerRequest.parse({ query: "504 타임아웃" }).stream).toBe(false);
  });

  it("stream:true를 받는다", () => {
    expect(AnswerRequest.parse({ query: "504 타임아웃", stream: true }).stream).toBe(
      true,
    );
  });

  it("stream은 boolean만 허용한다", () => {
    expect(
      AnswerRequest.safeParse({ query: "504 타임아웃", stream: "yes" }).success,
    ).toBe(false);
  });
});

describe("ListRecordsResponse", () => {
  const summary = {
    _id: "0123456789abcdef01234567",
    type: "incident",
    project: "sentinel-kb",
    title: "MCP 서버 504 게이트웨이 타임아웃",
    summary: "nginx 버퍼링으로 SSE가 죽었다. proxy_buffering off로 해결.",
    severity: "SEV2",
    tags: ["mcp"],
    sanitizeFlags: [],
    status: "published",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
  };

  it("요약 항목의 페이지를 파싱한다", () => {
    expect(
      ListRecordsResponse.safeParse({ items: [summary], nextCursor: null }).success,
    ).toBe(true);
  });

  /**
   * 목록이 본문을 실으면 이를 감싸는 MCP 도구가 즉시 NFR-03을 위반한다.
   * specs/04는 "(본문 포함)"을 단건 조회에만 달았다 — 이 테스트가 그 경계의 회귀 방지선이다.
   */
  it.each([
    "symptom",
    "rootCause",
    "resolution",
    "prevention",
    "expected",
    "actual",
    "correction",
    "context",
  ])("목록 항목에 본문 필드 %s를 실으면 거부한다 (NFR-03)", (field) => {
    expect(
      ListRecordsResponse.safeParse({
        items: [{ ...summary, [field]: "본문이 여기 오면 안 된다" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe("AnswerResponse", () => {
  const citation = {
    recordId: "0123456789abcdef01234567",
    section: "resolution",
    title: "MCP 서버 504",
    score: 0.82,
  };

  it("found:true는 인용을 최소 1개 요구한다 — 근거 없는 생성 금지 (NFR-02)", () => {
    expect(
      AnswerResponse.safeParse({
        found: true,
        answer: "nginx proxy_read_timeout을 올려라.",
        citations: [],
      }).success,
    ).toBe(false);

    expect(
      AnswerResponse.safeParse({
        found: true,
        answer: "nginx proxy_read_timeout을 올려라.",
        citations: [citation],
      }).success,
    ).toBe(true);
  });

  it("found:false 갈래는 message + suggestRecord:true다 (specs/03:39, specs/07:32)", () => {
    expect(
      AnswerResponse.safeParse({
        found: false,
        message: "유사 사례 없음",
        suggestRecord: true,
      }).success,
    ).toBe(true);
  });

  it.each(["message", "suggestRecord"])(
    "found:false에서 %s가 누락되면 거부한다",
    (field) => {
      expect(
        AnswerResponse.safeParse(
          without(
            { found: false, message: "유사 사례 없음", suggestRecord: true },
            field,
          ),
        ).success,
      ).toBe(false);
    },
  );

  /**
   * suggestRecord는 에이전트를 record_knowledge로 유도하는 기계 판독 신호다.
   * found:false인데 suggestRecord:false인 상태는 스펙상 존재하지 않으므로 literal(true)다.
   */
  it("found:false + suggestRecord:false는 스펙상 존재하지 않는 상태라 거부한다", () => {
    expect(
      AnswerResponse.safeParse({
        found: false,
        message: "유사 사례 없음",
        suggestRecord: false,
      }).success,
    ).toBe(false);
  });

  it("found:false 갈래는 answer를 실을 수 없다", () => {
    expect(
      AnswerResponse.safeParse({
        found: false,
        message: "유사 사례 없음",
        suggestRecord: true,
        answer: "지어낸 답",
      }).success,
    ).toBe(false);
  });

  it("구현이 발명했던 suggestion 필드는 계약에 없다", () => {
    expect(
      AnswerResponse.safeParse({ found: false, suggestion: "검색어를 좁혀보라" })
        .success,
    ).toBe(false);
  });

  it("found 없이는 파싱되지 않는다", () => {
    expect(AnswerResponse.safeParse({ answer: "지어낸 답" }).success).toBe(false);
  });
});

describe("HealthResponse", () => {
  it("specs/04의 4개 필드를 요구한다", () => {
    expect(
      HealthResponse.safeParse({
        status: "ok",
        mongo: "up",
        embeddingVersion: 1,
        version: "1.0.0",
      }).success,
    ).toBe(true);

    expect(
      HealthResponse.safeParse({ status: "ok", mongo: "up", version: "1.0.0" })
        .success,
    ).toBe(false);
  });
});

describe("ApiError", () => {
  it.each(["NOT_FOUND", "RATE_LIMITED", "E2_BAD_INPUT"])(
    "SCREAMING_SNAKE code %s를 허용한다",
    (code) => {
      expect(ApiError.safeParse({ error: { code, message: "x" } }).success).toBe(
        true,
      );
    },
  );

  it.each(["not_found", "NotFound", "_LEADING", "9_LEADING", ""])(
    "SCREAMING_SNAKE가 아닌 code %s는 거부한다",
    (code) => {
      expect(ApiError.safeParse({ error: { code, message: "x" } }).success).toBe(
        false,
      );
    },
  );

  it("details는 선택이다", () => {
    expect(
      ApiError.safeParse({
        error: { code: "BAD_REQUEST", message: "x", details: { field: "title" } },
      }).success,
    ).toBe(true);
  });
});
