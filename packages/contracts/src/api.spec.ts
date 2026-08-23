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
  ArticleIdParam,
  ListArticlesQuery,
  ListArticlesResponse,
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

// ---------------------------------------------------------------- 아티클 (B-1, specs/04 표)

describe("ListArticlesQuery", () => {
  /**
   * **이 스위트에서 가장 중요한 단언이다.**
   * specs/04: "기본은 `published`만. `status=candidate|draft`를 명시해야 후보 큐가 보인다."
   * 기대값은 리터럴 `"published"`다 — `ArticleStatus.options[2]` 같은 식으로 끌어오면
   * 기본값을 바꿔도 기대값이 따라 움직여 아무것도 검증하지 못한다.
   */
  it("status를 주지 않으면 published다 — 후보 큐는 명시해야 보인다", () => {
    expect(ListArticlesQuery.parse({}).status).toBe("published");
  });

  it("status는 파싱 결과에서 절대 undefined가 아니다 — 라우트가 필터를 잊을 수 없다", () => {
    // `.optional()`로 바꾸는 뮤테이션이 여기서 죽는다. 라우트의 `filter.status`가
    // 조건 없이 값을 넣을 수 있는 근거가 이 성질이다.
    expect(ListArticlesQuery.parse({}).status).toBeDefined();
    expect(ListArticlesQuery.parse({ limit: "5" }).status).toBeDefined();
  });

  it.each(["candidate", "draft", "published", "rejected"])(
    "명시한 status %s는 그대로 통과시킨다",
    (status) => {
      expect(ListArticlesQuery.parse({ status }).status).toBe(status);
    },
  );

  it("계약 밖 status는 거부한다", () => {
    expect(ListArticlesQuery.safeParse({ status: "all" }).success).toBe(false);
    expect(ListArticlesQuery.safeParse({ status: "" }).success).toBe(false);
  });

  it("status 배열을 받지 않는다 — '명시해야 보인다'가 새어 나가는 경로다", () => {
    expect(ListArticlesQuery.safeParse({ status: ["published", "candidate"] }).success).toBe(
      false,
    );
  });

  it("limit 기본값은 20이고 100을 넘으면 거부한다", () => {
    expect(ListArticlesQuery.parse({}).limit).toBe(20);
    expect(ListArticlesQuery.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("offset은 거부한다 — cursor 방식만 허용한다 (specs/04 규약)", () => {
    expect(ListArticlesQuery.safeParse({ offset: 10 }).success).toBe(false);
  });

  it("project 같은 미승인 파라미터를 조용히 버리지 않는다", () => {
    expect(ListArticlesQuery.safeParse({ project: "sentinel-kb" }).success).toBe(false);
  });
});

describe("ListArticlesResponse", () => {
  const item = {
    _id: "0123456789abcdef01234567",
    kind: "pattern",
    title: "패턴: mongodb 태그에서 반복된 3건",
    slug: "pattern-mongodb-0123abcd",
    status: "published",
    sourceRecordCount: 3,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    publishedAt: new Date("2026-08-02T00:00:00Z"),
  };

  it("본문 없는 요약 항목을 통과시킨다", () => {
    expect(ListArticlesResponse.safeParse({ items: [item], nextCursor: null }).success).toBe(
      true,
    );
  });

  /**
   * **NFR-03의 잠금장치.** specs/04 표가 아티클 목록에 "본문 없는 요약"을 명시했고,
   * `ArticleSummary`의 `.strict()`가 그것을 강제한다. 본문을 끼워 넣는 뮤테이션이 여기서 죽는다.
   */
  it.each(["body", "facts", "charts", "lintReport", "editHistory"])(
    "목록 항목에 %s를 실으면 거부한다 (NFR-03)",
    (field) => {
      const polluted = { ...item, [field]: "…" };
      expect(
        ListArticlesResponse.safeParse({ items: [polluted], nextCursor: null }).success,
      ).toBe(false);
    },
  );

  it("nextCursor는 마지막 페이지에서 null이다", () => {
    const parsed = ListArticlesResponse.parse({ items: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });
});

describe("ArticleIdParam", () => {
  it("24자 hex만 받는다", () => {
    expect(ArticleIdParam.safeParse({ id: "0123456789abcdef01234567" }).success).toBe(true);
    expect(ArticleIdParam.safeParse({ id: "nope" }).success).toBe(false);
  });
});
