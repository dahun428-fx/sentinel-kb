/**
 * 리포트 스키마와 **`baselines.json`과의 키 일치**를 잠근다.
 *
 * 키가 어긋나면 회귀 가드는 값을 못 찾아 조용히 통과한다 — 항상 통과하는 가드는 없는 가드보다
 * 나쁘다. 그래서 실제 파일을 읽어 단언한다(T-013 `eval/retrieval/report.spec.ts`와 같은 규약).
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BASELINES_URL, readBaselines } from "./baselines.js";
import { makeReportFixture } from "./report-fixture.js";
import {
  ToolsReport,
  TOOLS_METRIC_KEYS,
  TOOLS_REPORT_FILE_PATTERN,
  toolsReportFileName,
  toReportDate,
} from "./report.js";

describe("지표 키 ↔ baselines.json", () => {
  it("리포트 지표 키 집합이 baselines.json의 tools와 글자 그대로 같다", async () => {
    const raw: unknown = JSON.parse(await readFile(BASELINES_URL, "utf8"));
    const tools = (raw as { tools: Record<string, number> }).tools;
    expect(Object.keys(tools).sort()).toEqual([...TOOLS_METRIC_KEYS].sort());
  });

  it("커밋된 tool-selection 기준선은 0.85다 (T-016 Acceptance 1의 M3 기준선)", async () => {
    const baselines = await readBaselines();
    expect(baselines.tools.selectionAccuracy).toBe(0.85);
  });
});

describe("리포트 파일명", () => {
  it("T-016 Scope의 {date}-tools.json 규약을 따른다", () => {
    expect(toolsReportFileName("2026-08-23")).toBe("2026-08-23-tools.json");
    expect(TOOLS_REPORT_FILE_PATTERN.test("2026-08-23-tools.json")).toBe(true);
  });

  it("날짜 형식이 아니면 파일명을 만들지 않는다", () => {
    expect(() => toolsReportFileName("2026-8-3")).toThrow();
  });

  it("UTC로 고정한다 — 로컬 타임존에 따라 파일명이 하루 밀리지 않는다", () => {
    expect(toReportDate(new Date("2026-08-23T23:30:00.000Z"))).toBe("2026-08-23");
  });
});

describe("ToolsReport 스키마", () => {
  it("픽스처가 스키마를 통과한다", () => {
    expect(() => ToolsReport.parse(makeReportFixture())).not.toThrow();
  });

  it("모르는 필드를 허용하지 않는다 (.strict)", () => {
    expect(() => ToolsReport.parse({ ...makeReportFixture(), extra: 1 })).toThrow();
  });

  it("지표가 0..1 밖이면 계산 버그로 보고 거부한다", () => {
    expect(() =>
      ToolsReport.parse(makeReportFixture({ metrics: { selectionAccuracy: 1.2 } })),
    ).toThrow();
  });

  it("계약 지문은 sha256 형식이어야 한다", () => {
    const report = makeReportFixture();
    expect(() =>
      ToolsReport.parse({ ...report, catalog: { ...report.catalog, descriptionSha256: "짧다" } }),
    ).toThrow();
  });
});
