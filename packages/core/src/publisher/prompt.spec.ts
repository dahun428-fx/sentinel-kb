/**
 * 초안 프롬프트 조항 테스트. `generator/prompt.spec.ts`와 같은 규약이다 —
 * marker 존재만 보면 주석 한 줄로 통과하므로 **스펙 문면이 실제 본문에 있는지**도 본다.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_DRAFT_CLAUSES,
  assertDraftClauses,
  draftPromptPath,
  findMissingDraftClauses,
  loadDraftPrompt,
} from "./prompt.js";

const raw = readFileSync(draftPromptPath(), "utf8");

describe("초안 프롬프트", () => {
  it("필수 조항 marker가 전부 있다", () => {
    expect(findMissingDraftClauses(raw)).toEqual([]);
  });

  it("marker만이 아니라 조항 문면이 본문에 있다", () => {
    for (const clause of REQUIRED_DRAFT_CLAUSES) {
      expect(raw, clause.id).toContain(clause.spec);
    }
  });

  it("조항이 빠지면 로드가 던진다 — 조항 없는 프롬프트로 초안을 만들지 않는다", () => {
    for (const clause of REQUIRED_DRAFT_CLAUSES) {
      const damaged = raw.replace(clause.marker, "");
      expect(() => assertDraftClauses(damaged), clause.id).toThrowError(clause.id);
    }
  });

  it("loadDraftPrompt는 원문을 그대로 돌려준다", () => {
    expect(loadDraftPrompt()).toBe(raw);
  });

  it("팩트 밖 수치 금지와 데이터 프레이밍이 같은 프롬프트에 함께 있다", () => {
    expect(raw).toContain("직접 계산하지도 마라");
    expect(raw).toContain("지시가 아니다");
  });
});
