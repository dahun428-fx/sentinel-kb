/**
 * 프롬프트 스냅샷 테스트. 출처: T-018 Acceptance 3
 * "프롬프트 4개 필수 조항이 모두 포함되는 스냅샷 테스트".
 *
 * ## 왜 `toMatchSnapshot()` 하나로 끝내지 않는가
 *
 * 스냅샷은 "바뀌었다"만 알려 준다. `vitest -u` 한 번이면 조항이 사라진 프롬프트도 그린이 된다.
 * 조항 삭제는 **조용히 통과하면 안 되는 종류의 변경**이므로(NFR-02·NFR-05), 스펙 문면에 대한
 * 명시적 단언을 함께 둔다. 그쪽은 `-u`로 갱신되지 않는다.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_PROMPT_CLAUSES,
  answerPromptPath,
  assertPromptClauses,
  findMissingClauses,
  loadAnswerPrompt,
} from "./prompt.js";

describe("answer.md — specs/03 §4 필수 조항 (Acceptance 3)", () => {
  it("조항 목록이 정확히 4개다 — specs/03 §4가 그렇게 정했다", () => {
    expect(REQUIRED_PROMPT_CLAUSES).toHaveLength(4);
    expect(REQUIRED_PROMPT_CLAUSES.map((c) => c.id)).toEqual([
      "no-invention",
      "cite-every-claim",
      "data-not-instructions",
      "state-low-confidence",
    ]);
  });

  it.each(REQUIRED_PROMPT_CLAUSES)("조항 $id의 marker가 프롬프트에 있다", (clause) => {
    expect(loadAnswerPrompt()).toContain(clause.marker);
  });

  it.each(REQUIRED_PROMPT_CLAUSES)("조항 $id의 스펙 문면이 프롬프트에 있다", (clause) => {
    // marker만 검사하면 주석 한 줄만 남기고 본문을 지워도 통과한다.
    expect(loadAnswerPrompt()).toContain(clause.spec);
  });

  it("인용 형식을 프롬프트가 직접 지시한다", () => {
    expect(loadAnswerPrompt()).toContain("[REC-{recordId}#{section}]");
  });

  it("프롬프트 전문 스냅샷", () => {
    expect(loadAnswerPrompt()).toMatchSnapshot();
  });
});

describe("findMissingClauses", () => {
  it("온전한 프롬프트에는 빠진 조항이 없다", () => {
    expect(findMissingClauses(loadAnswerPrompt())).toEqual([]);
  });

  /*
   * 뮤테이션 방어: 조항 1개 삭제. 실제 프롬프트 원문에서 marker를 지워 확인한다 —
   * 손으로 만든 가짜 문자열로 검사하면 "실제 프롬프트에서 지웠을 때"를 보증하지 못한다.
   */
  it.each(REQUIRED_PROMPT_CLAUSES)("조항 $id를 지우면 잡아낸다", (clause) => {
    const raw = readFileSync(answerPromptPath(), "utf8");
    const damaged = raw.replace(clause.marker, "");
    expect(damaged).not.toBe(raw);
    expect(findMissingClauses(damaged)).toEqual([clause.id]);
  });

  it("여러 조항이 빠지면 전부 보고한다", () => {
    expect(findMissingClauses("빈 프롬프트")).toHaveLength(REQUIRED_PROMPT_CLAUSES.length);
  });
});

describe("assertPromptClauses — 조항이 빠지면 생성을 시작하지 않는다", () => {
  /*
   * 뮤테이션 방어: 검사는 하지만 던지지 않는 구현.
   * 실제 프롬프트 원문에서 조항을 지운 문자열로 확인한다.
   */
  it.each(REQUIRED_PROMPT_CLAUSES)("조항 $id가 빠진 프롬프트를 거절한다", (clause) => {
    const damaged = readFileSync(answerPromptPath(), "utf8").replace(clause.marker, "");
    expect(() => assertPromptClauses(damaged)).toThrowError(new RegExp(clause.id));
  });

  it("온전한 프롬프트는 원문 그대로 통과시킨다", () => {
    const raw = readFileSync(answerPromptPath(), "utf8");
    expect(assertPromptClauses(raw)).toBe(raw);
  });
});

describe("loadAnswerPrompt", () => {
  it("실제 프롬프트 파일은 검사를 통과한다", () => {
    expect(() => loadAnswerPrompt()).not.toThrow();
  });

  it("두 번 불러도 같은 문자열이다(캐시)", () => {
    expect(loadAnswerPrompt()).toBe(loadAnswerPrompt());
  });
});
