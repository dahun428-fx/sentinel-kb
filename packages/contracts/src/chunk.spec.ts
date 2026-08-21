import { describe, expect, it } from "vitest";

import { ChunkSchema } from "./chunk.js";
import { without } from "./spec-helpers.js";

const VALID = {
  _id: "0123456789abcdef01234567",
  recordId: "0123456789abcdef01234568",
  section: "resolution",
  seq: 0,
  text: "nginx proxy_read_timeout을 120s로 올린다",
  embedding: [0.1, -0.2, 0.3],
  meta: {
    type: "incident",
    project: "sentinel-kb",
    severity: "SEV2",
    tags: ["nginx"],
    sanitizeFlags: [],
  },
  embeddingVersion: 1,
};

describe("ChunkSchema", () => {
  it("유효한 청크를 파싱한다", () => {
    expect(ChunkSchema.safeParse(VALID).success).toBe(true);
  });

  it("빈 임베딩은 거부한다", () => {
    expect(ChunkSchema.safeParse({ ...VALID, embedding: [] }).success).toBe(false);
  });

  it("정의되지 않은 섹션은 거부한다", () => {
    expect(ChunkSchema.safeParse({ ...VALID, section: "title" }).success).toBe(false);
  });

  it("벡터 인덱스 필터 필드(meta.type, meta.project, embeddingVersion)를 요구한다", () => {
    expect(ChunkSchema.safeParse(without(VALID, "embeddingVersion")).success).toBe(
      false,
    );
    expect(
      ChunkSchema.safeParse({ ...VALID, meta: without(VALID.meta, "type") }).success,
    ).toBe(false);
    expect(
      ChunkSchema.safeParse({ ...VALID, meta: without(VALID.meta, "project") })
        .success,
    ).toBe(false);
  });

  /**
   * seq는 specs/03:9의 upsert 유니크 키 {recordId, section, seq, embeddingVersion}의 일부다.
   * 빠지면 1200자 초과 섹션의 2번째 청크가 1번째를 덮어써 본문이 조용히 사라진다.
   */
  it("같은 섹션이 여러 청크로 쪼개지면 seq로 구분된다", () => {
    expect(ChunkSchema.safeParse({ ...VALID, seq: 1 }).success).toBe(true);
  });

  it("seq가 누락되면 거부한다 — upsert 유니크 키가 무너진다 (specs/03:9)", () => {
    expect(ChunkSchema.safeParse(without(VALID, "seq")).success).toBe(false);
  });

  it.each([-1, 0.5, "0", null])("seq %s는 거부한다", (seq) => {
    expect(ChunkSchema.safeParse({ ...VALID, seq }).success).toBe(false);
  });

  it("embedding 차원은 스키마에 고정하지 않는다 — EMBEDDING_DIM은 런타임 값이다", () => {
    const long = Array.from({ length: 3072 }, () => 0.01);
    expect(ChunkSchema.safeParse({ ...VALID, embedding: long }).success).toBe(true);
  });
});
