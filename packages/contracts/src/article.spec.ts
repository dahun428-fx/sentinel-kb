import { describe, expect, it } from "vitest";

import {
  ArticleSchema,
  ArticleSummary,
  ChartSpec,
  PatchArticleInput,
  PublishArticleInput,
} from "./article.js";

const OID = "0123456789abcdef01234567";

/** candidate 단계의 최소 형상 — 트리거 배치(T-029)가 실제로 쓰는 그것. */
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: OID,
    kind: "pattern",
    sourceRecordIds: [OID],
    title: "패턴: mongodb 태그에서 반복된 3건",
    slug: "pattern-mongodb-0123abcd",
    status: "candidate",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ArticleSchema", () => {
  it("본문 없는 candidate를 통과시킨다 (§4의 draft 저장은 나중이다)", () => {
    expect(ArticleSchema.safeParse(candidate()).success).toBe(true);
  });

  it("editHistory는 생략하면 빈 배열이 된다", () => {
    const parsed = ArticleSchema.parse(candidate());
    expect(parsed.editHistory).toEqual([]);
  });

  it("body·publishedAt 없는 published를 거부한다 (specs/08 §0-5 전자동 발행 금지)", () => {
    const result = ArticleSchema.safeParse(candidate({ status: "published" }));
    expect(result.success).toBe(false);
  });

  it("body와 publishedAt이 갖춰진 published는 통과시킨다", () => {
    const result = ArticleSchema.safeParse(
      candidate({
        status: "published",
        body: "## 사건\n2026-08-01 03:12에 ...",
        publishedAt: new Date("2026-08-02T00:00:00Z"),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("소스 레코드가 하나도 없는 아티클을 거부한다", () => {
    expect(ArticleSchema.safeParse(candidate({ sourceRecordIds: [] })).success).toBe(false);
  });

  it("URL에 쓸 수 없는 slug를 거부한다", () => {
    expect(ArticleSchema.safeParse(candidate({ slug: "패턴 mongodb" })).success).toBe(false);
    expect(ArticleSchema.safeParse(candidate({ slug: "Pattern-Mongodb" })).success).toBe(false);
  });

  it("계약 밖 필드를 조용히 버리지 않고 거부한다", () => {
    expect(ArticleSchema.safeParse(candidate({ clusterKey: "mongodb" })).success).toBe(false);
  });
});

describe("ChartSpec", () => {
  it("specs/08 §5.1의 4종 타입만 받는다", () => {
    for (const type of ["bar", "line", "heatmap", "timeline"]) {
      expect(ChartSpec.safeParse({ type, data: [], caption: "태그 빈도" }).success).toBe(true);
    }
    expect(ChartSpec.safeParse({ type: "pie", data: [], caption: "x" }).success).toBe(false);
  });

  it("caption 없는 차트를 거부한다 — 설명 없는 그림은 밀도를 올리지 않는다", () => {
    expect(ChartSpec.safeParse({ type: "bar", data: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- HTTP 표면 (B-1, specs/04 표)

describe("ArticleSummary", () => {
  const summary = {
    _id: OID,
    kind: "pattern",
    title: "패턴: mongodb 태그에서 반복된 3건",
    slug: "pattern-mongodb-0123abcd",
    status: "candidate",
    sourceRecordCount: 3,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };

  it("본문 없는 요약을 통과시킨다", () => {
    expect(ArticleSummary.safeParse(summary).success).toBe(true);
  });

  it("publishedAt은 선택이다 — 미발행 아티클에는 없다", () => {
    expect(ArticleSummary.safeParse({ ...summary, publishedAt: new Date() }).success).toBe(true);
  });

  /** specs/04: 아티클 목록은 "본문 없는 요약". `.strict()`가 그 경계다(NFR-03). */
  it.each(["body", "facts", "charts", "lintReport", "editHistory", "sourceRecordIds"])(
    "요약에 %s를 실으면 거부한다",
    (field) => {
      expect(ArticleSummary.safeParse({ ...summary, [field]: "x" }).success).toBe(false);
    },
  );

  it("근거가 몇 건인지는 남긴다 — 요약이 판단 근거가 되어야 한다", () => {
    expect(ArticleSummary.parse(summary).sourceRecordCount).toBe(3);
    // 0건짜리 아티클은 존재하지 않는다(ArticleSchema의 `.min(1)`과 같은 규칙).
    expect(ArticleSummary.safeParse({ ...summary, sourceRecordCount: 0 }).success).toBe(false);
  });
});

describe("PatchArticleInput", () => {
  it("본문·제목·차트를 부분 수정할 수 있다", () => {
    expect(PatchArticleInput.safeParse({ body: "## 사건\n2026-08-01 03:12에 ..." }).success).toBe(
      true,
    );
    expect(PatchArticleInput.safeParse({ title: "다시 쓴 제목" }).success).toBe(true);
    expect(
      PatchArticleInput.safeParse({ charts: [{ type: "bar", data: [], caption: "태그 빈도" }] })
        .success,
    ).toBe(true);
  });

  it("빈 패치는 거부한다 — 수정 의도 없는 PATCH는 계약 위반이다", () => {
    expect(PatchArticleInput.safeParse({}).success).toBe(false);
  });

  /**
   * **PATCH로는 발행할 수 없다.** 발행은 `POST /v1/articles/:id/publish`의 몫이고,
   * 시각을 찍는 코드는 그쪽에만 있다. 이 단언이 없으면 편집 경로가 두 번째 발행 경로가 된다.
   */
  it("status로 published를 지정할 수 없다 — 발행은 별도 오퍼레이션이다", () => {
    expect(PatchArticleInput.safeParse({ status: "published" }).success).toBe(false);
  });

  it("status로 candidate를 되돌릴 수 없다 — 배치가 만드는 초기 상태다", () => {
    expect(PatchArticleInput.safeParse({ status: "candidate" }).success).toBe(false);
  });

  it.each(["draft", "rejected"])("사람이 지정할 수 있는 status %s는 받는다", (status) => {
    expect(PatchArticleInput.safeParse({ status }).success).toBe(true);
  });

  /** specs/04: `publishedAt`은 서버가 찍는다. 편집 경로로도 들어올 수 없어야 한다. */
  it.each(["publishedAt", "project", "_id", "createdAt", "slug", "editHistory", "sourceRecordIds"])(
    "서버 소유 필드 %s를 조용히 버리지 않고 거부한다",
    (field) => {
      expect(PatchArticleInput.safeParse({ body: "본문", [field]: "x" }).success).toBe(false);
    },
  );
});

describe("PublishArticleInput", () => {
  it("빈 바디만 받는다", () => {
    expect(PublishArticleInput.safeParse({}).success).toBe(true);
  });

  /**
   * **specs/04의 핵심 문장이 이 단언이다**: "`publishedAt`은 서버가 찍는다 — 클라이언트가 보내면 400".
   * 키를 하나씩 골라 막는 대신 아무 키도 받지 않으므로, 미래에 추가될 필드도 자동으로 막힌다.
   */
  it.each(["publishedAt", "status", "project", "body", "anythingElse"])(
    "바디에 %s가 오면 거부한다",
    (field) => {
      expect(PublishArticleInput.safeParse({ [field]: "x" }).success).toBe(false);
    },
  );

  it("publishedAt이 Date여도 거부한다 — 형식 문제가 아니라 소유권 문제다", () => {
    expect(
      PublishArticleInput.safeParse({ publishedAt: new Date("2026-08-02T00:00:00Z") }).success,
    ).toBe(false);
  });
});
