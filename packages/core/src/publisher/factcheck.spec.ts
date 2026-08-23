/**
 * 팩트 대조 테스트 — T-031 Acceptance 2 "facts에 없는 수치를 심은 모의 초안이 반려됨".
 *
 * 축이 다섯이라 케이스도 다섯이다. 수치 하나만 재면 "이 대조기는 숫자만 본다"는 사실이
 * 테스트에 드러나지 않고, 지어낸 명령어·로그가 발행물에 실리는 경로가 열린 채 초록이 된다.
 */
import { describe, expect, it } from "vitest";

import { buildAllowedFacts, crossCheckFacts } from "./factcheck.js";
import {
  ACCEPTED_DRAFT,
  DRAFT_WITH_DERIVED_RATIO,
  DRAFT_WITH_INVENTED_COMMAND,
  DRAFT_WITH_INVENTED_DATE,
  DRAFT_WITH_INVENTED_LOG,
  DRAFT_WITH_INVENTED_NUMBER,
  fixtureFacts,
} from "./publisher.fixture.js";

const facts = fixtureFacts();

describe("crossCheckFacts", () => {
  it("팩트 팩 안에서만 쓴 초안은 통과한다", () => {
    const report = crossCheckFacts(ACCEPTED_DRAFT, facts);
    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("검사한 토큰 수를 남긴다 — 0건 검사와 0건 위반은 다르다", () => {
    const report = crossCheckFacts(ACCEPTED_DRAFT, facts);
    expect(report.checked.codeLines).toBeGreaterThan(0);
    expect(report.checked.quotes).toBeGreaterThan(0);
    expect(report.checked.dates).toBeGreaterThan(0);
    expect(report.checked.numbers).toBeGreaterThan(0);
  });

  it("facts에 없는 수치를 심으면 반려한다", () => {
    const report = crossCheckFacts(DRAFT_WITH_INVENTED_NUMBER, facts);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([{ kind: "number", value: "97" }]);
  });

  it("facts에 없는 명령어를 인용하면 반려한다", () => {
    const report = crossCheckFacts(DRAFT_WITH_INVENTED_COMMAND, facts);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([
      { kind: "quote", value: "pnpm rebuild --recursive --offline" },
    ]);
  });

  it("타임라인에 없는 날짜를 쓰면 반려한다 — 숫자런 대조만으로는 새는 축이다", () => {
    const report = crossCheckFacts(DRAFT_WITH_INVENTED_DATE, facts);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([{ kind: "date", value: "2026-06-11" }]);
  });

  it("코드 블록에 없는 로그 줄을 넣으면 반려한다", () => {
    const report = crossCheckFacts(DRAFT_WITH_INVENTED_LOG, facts);
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.kind)).toContain("code-line");
  });

  it("모델이 산술한 비율은 반려한다 — 통계는 코드가 계산한다(§0-1)", () => {
    const report = crossCheckFacts(DRAFT_WITH_DERIVED_RATIO, facts);
    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([{ kind: "number", value: "71" }]);
  });

  it("소스 집합 밖의 레코드 ID를 쓰면 반려한다", () => {
    const body = ACCEPTED_DRAFT.replace(
      "로그에 남은 것은 한 줄이었다.",
      "로그에 남은 것은 한 줄이었다. 관련 레코드는 bbbbbbbbbbbbbbbbbbbb9999다.",
    );
    const report = crossCheckFacts(body, facts);
    expect(report.violations).toContainEqual({
      kind: "record-id",
      value: "bbbbbbbbbbbbbbbbbbbb9999",
    });
  });

  it("순서 매김(`1. `)은 주장이 아니라 구조 표시라 검사하지 않는다", () => {
    const body = ACCEPTED_DRAFT.replace(
      "재발 간격은 고르지 않았다.",
      "재발 간격은 고르지 않았다.\n\n1. 첫 관측\n2. 재발\n",
    );
    expect(crossCheckFacts(body, facts).passed).toBe(true);
  });

  it("같은 위반이 여러 번 나와도 한 번만 센다", () => {
    const body = `${DRAFT_WITH_INVENTED_NUMBER}\n\n다시 말하지만 97건이다.\n`;
    expect(crossCheckFacts(body, facts).violations).toHaveLength(1);
  });
});

describe("buildAllowedFacts", () => {
  it("허용 집합은 팩트 팩에서만 나온다 — 인용 원문과 그 안의 숫자가 함께 들어간다", () => {
    const allowed = buildAllowedFacts(facts);
    expect(allowed.strings).toContain("pnpm approve-builds");
    // `nc -vz node0.example.net 27017` 안의 포트. 스니펫과 함께 실리므로 허용된다.
    expect(allowed.numbers.has("27017")).toBe(true);
    expect(allowed.dates.has(facts.period.firstAt.slice(0, 10))).toBe(true);
    expect(allowed.recordIds.size).toBe(facts.sourceRecordIds.length);
  });

  it("팩트 팩에 없는 수치는 허용 집합에도 없다", () => {
    const allowed = buildAllowedFacts(facts);
    expect(allowed.numbers.has("97")).toBe(false);
    expect(allowed.dates.has("2026-06-11")).toBe(false);
  });
});
