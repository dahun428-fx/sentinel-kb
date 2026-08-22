/**
 * 커밋된 케이스 파일 자체를 검사한다. **실제 파일을 읽는다** — 픽스처로 검사하면
 * `cases.json`이 망가져도 초록이다.
 */
import { describe, expect, it } from "vitest";

import {
  EXPECTED_CASE_COUNT,
  EXPECTED_IRRELEVANT_COUNT,
  caseWarnings,
  expectsFound,
  loadCases,
} from "./cases.js";

describe("eval/generation/cases.json", () => {
  const cases = loadCases();

  it("케이스를 실제로 읽었다", () => {
    expect(cases.length).toBe(EXPECTED_CASE_COUNT);
  });

  /** specs/05 Eval 2(c): "무관한 쿼리 5개 → 전부 found:false". */
  it("무관한 쿼리가 정확히 5건이다", () => {
    expect(cases.filter((item) => item.kind === "irrelevant")).toHaveLength(
      EXPECTED_IRRELEVANT_COUNT,
    );
  });

  it("caseId가 중복되지 않는다", () => {
    const ids = cases.map((item) => item.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** 케이스에 정답 답변이 섞여 들어오면 그 순간 골든셋이 오염된다(eval-runner 스킬). */
  it("케이스에 정답 답변이 들어 있지 않다", () => {
    for (const item of cases) {
      expect(Object.keys(item).sort()).toEqual(["boundary", "caseId", "kind", "query"]);
      expect(item.query).not.toContain("[REC-");
    }
  });

  it("모든 케이스가 무엇을 가르는지 적어 두었다", () => {
    for (const item of cases) {
      expect(item.boundary.length, `${item.caseId}에 boundary가 비어 있다`).toBeGreaterThan(5);
    }
  });

  it("irrelevant는 답을 기대하지 않고 grounded는 기대한다", () => {
    expect(expectsFound({ caseId: "x", kind: "grounded", query: "q", boundary: "b" })).toBe(true);
    expect(expectsFound({ caseId: "x", kind: "irrelevant", query: "q", boundary: "b" })).toBe(false);
  });

  it("커밋된 케이스 집합에는 경고가 없다", () => {
    expect(caseWarnings(cases, EXPECTED_CASE_COUNT)).toEqual([]);
  });

  it("무관한 쿼리가 줄면 경고가 붙는다 — 고치지 않고 보고만 한다", () => {
    const trimmed = cases.filter((item) => item.kind === "grounded");
    expect(caseWarnings(trimmed, trimmed.length).join("\n")).toContain("무관한 쿼리가 0건");
  });
});
