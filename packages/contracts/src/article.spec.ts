import { describe, expect, it } from "vitest";

import { ArticleSchema, ChartSpec } from "./article.js";

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
