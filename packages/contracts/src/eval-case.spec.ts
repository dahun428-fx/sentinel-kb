import { describe, expect, it } from "vitest";

import { EvalCaseSchema } from "./eval-case.js";
import { without } from "./spec-helpers.js";

const VALID = {
  _id: "0123456789abcdef01234567",
  query: "MCP 호출이 504로 실패한다",
  expectedRecordIds: ["0123456789abcdef01234568"],
  approvedBy: "human",
};

describe("EvalCaseSchema", () => {
  it("사람이 승인한 케이스를 파싱한다", () => {
    expect(EvalCaseSchema.safeParse(VALID).success).toBe(true);
  });

  // specs/02: eval_cases는 사람 승인 없이 자동 추가 금지
  it.each(["agent", "auto", "system", "Human", ""])(
    "approvedBy가 %s면 거부한다 — 자동 생성 골든셋은 eval을 오염시킨다",
    (approvedBy) => {
      expect(EvalCaseSchema.safeParse({ ...VALID, approvedBy }).success).toBe(false);
    },
  );

  it("approvedBy가 없으면 거부한다", () => {
    expect(EvalCaseSchema.safeParse(without(VALID, "approvedBy")).success).toBe(false);
  });

  it("expectedRecordIds가 비면 거부한다", () => {
    expect(
      EvalCaseSchema.safeParse({ ...VALID, expectedRecordIds: [] }).success,
    ).toBe(false);
  });

  it("expectedRecordIds는 ObjectId 문자열이어야 한다", () => {
    expect(
      EvalCaseSchema.safeParse({ ...VALID, expectedRecordIds: ["nope"] }).success,
    ).toBe(false);
  });
});
