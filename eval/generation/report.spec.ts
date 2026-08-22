/**
 * 리포트 스키마 ↔ `eval/baselines.json`의 대조. **이 파일이 없으면 회귀 가드가 조용히
 * 항상 통과할 수 있다** — 지표 키가 어긋나면 `checkBaselines`가 아무것도 못 찾기 때문이다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BASELINES_URL } from "./baselines.js";
import {
  GENERATION_METRIC_KEYS,
  GENERATION_REPORT_FILE_PATTERN,
  GenerationReport,
  generationReportFileName,
  toReportDate,
} from "./report.js";
import { makeReportFixture } from "./report-fixture.js";

describe("generation 리포트 스키마", () => {
  /** **실제 파일을 읽는다.** 상수를 import해 비교하면 자기충족적이 되어 아무것도 검증하지 못한다. */
  it("지표 키가 eval/baselines.json의 generation 절과 글자 그대로 같다", () => {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(BASELINES_URL), "utf8"));
    const generation = (raw as { generation: Record<string, number> }).generation;

    expect(Object.keys(generation).sort()).toEqual([...GENERATION_METRIC_KEYS].sort());
  });

  /** specs/05 Eval 2(a)의 "100% 요구"가 그대로 파일에 있는지 본다. 낮추는 커밋은 여기서 죽는다. */
  it("citationRuleCheck 기준선은 1.0이다 (specs/05: 자동, 100% 요구)", () => {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(BASELINES_URL), "utf8"));
    const generation = (raw as { generation: Record<string, number> }).generation;

    expect(generation["citationRuleCheck"]).toBe(1);
    expect(generation["faithfulness"]).toBe(4);
    expect(generation["usefulness"]).toBe(3.5);
  });

  it("픽스처 리포트가 스키마를 만족한다", () => {
    expect(() => GenerationReport.parse(makeReportFixture())).not.toThrow();
  });

  it("계약에 없는 키는 거부한다 (.strict())", () => {
    expect(() =>
      GenerationReport.parse({ ...makeReportFixture(), extra: 1 }),
    ).toThrow();
  });

  /** judge 점수는 1–5 척도다. 0..1로 정규화해 넣으면 전 리포트가 회귀로 찍힌다. */
  it("faithfulness 4.5는 유효하고 5.5는 스키마에서 죽는다", () => {
    expect(() =>
      GenerationReport.parse(makeReportFixture({ metrics: { faithfulness: 4.5 } })),
    ).not.toThrow();
    expect(() =>
      GenerationReport.parse(makeReportFixture({ metrics: { faithfulness: 5.5 } })),
    ).toThrow();
  });

  it("citationRuleCheck는 0..1이다 — 4.0을 넣으면 죽는다", () => {
    expect(() =>
      GenerationReport.parse(makeReportFixture({ metrics: { citationRuleCheck: 4 } })),
    ).toThrow();
  });

  it("파일명은 {date}-generation.json이고 날짜 형식을 검사한다", () => {
    expect(generationReportFileName("2026-08-23")).toBe("2026-08-23-generation.json");
    expect(GENERATION_REPORT_FILE_PATTERN.test("2026-08-23-generation.json")).toBe(true);
    expect(() => generationReportFileName("2026-8-23")).toThrow();
  });

  it("리포트 날짜는 UTC 기준이다 — 로컬 타임존으로 하루 밀리지 않는다", () => {
    expect(toReportDate(new Date("2026-08-23T23:30:00.000Z"))).toBe("2026-08-23");
    expect(toReportDate(new Date("2026-08-23T00:30:00.000Z"))).toBe("2026-08-23");
  });
});
