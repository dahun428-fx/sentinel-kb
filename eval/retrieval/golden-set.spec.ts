import { APPROVED_EVAL_CASE_FILTER, type EvalCaseDocument } from "@sentinel/api";
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { goldenSetWarnings, toGoldenCase, EXPECTED_GOLDEN_SET_SIZE } from "./golden-set.js";

function document(overrides: Partial<EvalCaseDocument> = {}): EvalCaseDocument {
  return {
    _id: new ObjectId(),
    query: "nginx 502",
    expectedRecordIds: [new ObjectId()],
    approvedBy: "human",
    ...overrides,
  };
}

describe("골든셋 로더", () => {
  it("골든셋의 정의는 @sentinel/api의 필터 하나다 — 러너가 조건을 다시 적지 않는다", () => {
    expect(APPROVED_EVAL_CASE_FILTER).toEqual({ approvedBy: "human" });
  });

  it("ObjectId를 24자 hex로 낮춘다 (specs/02 DB 경계 규약)", () => {
    const id = new ObjectId();
    const recordId = new ObjectId();
    const golden = toGoldenCase(document({ _id: id, expectedRecordIds: [recordId] }));
    expect(golden.caseId).toBe(id.toHexString());
    expect(golden.expectedRecordIds).toEqual([recordId.toHexString()]);
  });

  it("질의 종류를 질의 텍스트에서 유도한다", () => {
    expect(toGoldenCase(document({ query: "nginx 502" })).queryKind).toBe("identifier");
    expect(toGoldenCase(document({ query: "스트리밍이 끊긴다" })).queryKind).toBe("korean-prose");
  });

  /**
   * 필터를 우회해 컬렉션에 손으로 넣은 문서가 지표에 섞이는 경로를 닫는다.
   * contracts의 `EvalCaseSchema`가 `approvedBy: z.literal("human")`이라 여기서 죽는다.
   */
  it("승인 표식이 없는 문서는 파싱 단계에서 죽는다", () => {
    const candidate = document();
    delete (candidate as { approvedBy?: unknown }).approvedBy;
    expect(() => toGoldenCase(candidate)).toThrow();
  });

  it("정답이 하나도 없는 케이스는 죽는다 — 절대 적중할 수 없는 케이스가 지표를 깎는다", () => {
    expect(() => toGoldenCase(document({ expectedRecordIds: [] }))).toThrow();
  });

  it("type 필터를 그대로 실어 나른다", () => {
    expect(toGoldenCase(document({ type: "incident" })).type).toBe("incident");
  });
});

describe("goldenSetWarnings — 골든셋을 고치지 않고 보고만 한다", () => {
  it("0건이면 T-013의 선행 결정(seedBatch, G3)을 가리킨다", () => {
    const warnings = goldenSetWarnings([]);
    expect(warnings.join("\n")).toContain("seedBatch");
  });

  it("specs/05의 30건과 다르면 경고한다", () => {
    expect(EXPECTED_GOLDEN_SET_SIZE).toBe(30);
    const cases = [toGoldenCase(document())];
    expect(goldenSetWarnings(cases).join("\n")).toContain("30건");
  });

  it("같은 query가 둘이면 가중치가 커진다고 경고한다", () => {
    const cases = [toGoldenCase(document()), toGoldenCase(document())];
    expect(goldenSetWarnings(cases, 2).join("\n")).toContain("같은 query");
  });

  it("한 종류로만 채워져 있으면 분해 집계가 무의미하다고 경고한다", () => {
    const cases = [toGoldenCase(document({ query: "nginx 502" }))];
    expect(goldenSetWarnings(cases, 1).join("\n")).toContain("한쪽으로 쏠려");
  });

  it("두 종류가 모두 있고 수가 맞으면 경고가 없다", () => {
    const cases = [
      toGoldenCase(document({ query: "nginx 502" })),
      toGoldenCase(document({ query: "스트리밍이 끊긴다" })),
    ];
    expect(goldenSetWarnings(cases, 2)).toEqual([]);
  });
});
