import { describe, expect, it } from "vitest";

import {
  ChunkSection,
  ObjectIdString,
  RelationType,
  Relation,
  SanitizeFlag,
} from "./common.js";

describe("ObjectIdString", () => {
  it("24자 hex를 통과시킨다", () => {
    expect(ObjectIdString.safeParse("0123456789abcdef01234567").success).toBe(true);
    expect(ObjectIdString.safeParse("0123456789ABCDEF01234567").success).toBe(true);
  });

  it.each([
    ["23자", "0123456789abcdef0123456"],
    ["25자", "0123456789abcdef012345678"],
    ["hex 아닌 문자 포함", "0123456789abcdef0123456z"],
    ["빈 문자열", ""],
  ])("%s는 거부한다", (_label, value) => {
    expect(ObjectIdString.safeParse(value).success).toBe(false);
  });
});

describe("SanitizeFlag", () => {
  it("specs/02가 명시한 2종만 허용한다", () => {
    expect(SanitizeFlag.options).toEqual(["secret-masked", "injection-suspect"]);
    expect(SanitizeFlag.safeParse("pii-removed").success).toBe(false);
  });
});

describe("RelationType", () => {
  it("specs/02의 4종을 허용한다", () => {
    expect(RelationType.options).toEqual([
      "recurrence_of",
      "same_root_cause",
      "related",
      "corrects",
    ]);
  });
});

describe("ChunkSection", () => {
  it("specs/02의 7개 섹션을 허용한다", () => {
    expect(ChunkSection.options).toHaveLength(7);
    expect(ChunkSection.safeParse("context").success).toBe(false);
  });
});

describe("Relation", () => {
  it("targetRecordId가 ObjectId 문자열이어야 한다", () => {
    expect(
      Relation.safeParse({ type: "related", targetRecordId: "abc" }).success,
    ).toBe(false);
    expect(
      Relation.safeParse({
        type: "related",
        targetRecordId: "0123456789abcdef01234567",
      }).success,
    ).toBe(true);
  });
});
