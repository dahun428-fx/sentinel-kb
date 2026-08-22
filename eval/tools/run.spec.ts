/**
 * 러너 전체를 모델 없이 돌린다. 스크립트 selector로 **일부러 틀리게** 만들어야
 * 집계·경고·판정이 진짜로 동작하는지 볼 수 있다.
 */
import { describe, expect, it } from "vitest";

import { exitCodeFor, UNRATIFIED_CONTRACT_NOTE } from "./baseline-guard.js";
import { loadToolCatalog } from "./catalog.js";
import { runToolsEval } from "./run.js";
import { loadScenarios } from "./scenarios.js";
import { createOracleSelector, createScriptedSelector, type ToolChoice } from "./selector.js";

const catalog = loadToolCatalog();
const scenarios = await loadScenarios(catalog);
const BASELINES = { selectionAccuracy: 0.85 };
const NOW = new Date("2026-08-23T12:00:00.000Z");

function run(selector: Parameters<typeof runToolsEval>[0]["selector"], repeats = 3) {
  return runToolsEval({
    scenarios,
    catalog,
    selector,
    repeats,
    baselines: BASELINES,
    now: NOW,
    expectedScenarioCount: scenarios.length,
  });
}

describe("runToolsEval — 오라클(만점) 경로", () => {
  it("모든 시나리오를 맞추면 정확도가 1.0이다", async () => {
    const report = await run(createOracleSelector(scenarios));
    expect(report.metrics.selectionAccuracy).toBe(1);
    expect(report.diagnostics.attempts).toBe(scenarios.length * 3);
    expect(report.confusions).toEqual([]);
  });

  /** **오라클 만점이 기준선 통과로 읽히면 이 eval은 거짓말이 된다.** */
  it("그래도 판정하지 않는다 — 종료 코드는 0이 아니라 78이다", async () => {
    const report = await run(createOracleSelector(scenarios));
    expect(report.regression.evaluated).toBe(false);
    expect(exitCodeFor(report.regression), "실제 모델 없이 판정하고 있다").toBe(78);
  });

  it("리포트에 계약 지문과 도구 5종이 박힌다 (G6)", async () => {
    const report = await run(createOracleSelector(scenarios));
    expect(report.catalog.toolCount).toBe(5);
    expect(report.catalog.descriptionSha256).toBe(catalog.descriptionSha256);
  });

  it("미비준 이탈 4건 경고가 조건 없이 실린다 — 비준이 기준선 확정보다 먼저다", async () => {
    const report = await run(createOracleSelector(scenarios));
    expect(report.warnings).toContain(UNRATIFIED_CONTRACT_NOTE);
  });

  it("파일명 날짜는 주입한 시각에서 나온다", async () => {
    const report = await run(createOracleSelector(scenarios));
    expect(report.date).toBe("2026-08-23");
  });
});

describe("runToolsEval — 틀리는 selector", () => {
  /** 모든 프롬프트에 대해 search_knowledge를 부르는 selector. "아무거나 부르는" 에이전트다. */
  function alwaysSearch(): ReadonlyMap<string, readonly ToolChoice[]> {
    return new Map(
      scenarios.map((scenario) => [
        scenario.prompt,
        [{ tool: "search_knowledge", args: { query: "무엇" } }] as readonly ToolChoice[],
      ]),
    );
  }

  it("도구 없음 케이스를 포함해 오답이 집계된다", async () => {
    const report = await run(createScriptedSelector(alwaysSearch()));
    expect(report.metrics.selectionAccuracy).toBeLessThan(1);

    const noneBucket = report.byExpectedTool.find((entry) => entry.expectedTool === null);
    expect(noneBucket?.selectionAccuracy, "도구를 불렀는데 '도구 없음' 케이스가 정답 처리됐다").toBe(0);
  });

  it("오답이 무엇을 골랐는지 리포트에 남는다 (Acceptance 2)", async () => {
    const report = await run(createScriptedSelector(alwaysSearch()));
    const wrong = report.confusions.find((entry) => entry.scenarioId === "TS-02");
    expect(wrong?.expectedTool).toBe("record_knowledge");
    expect(wrong?.chosenTool).toBe("search_knowledge");
  });

  it("회차마다 다른 도구를 고르면 불안정 경고가 붙는다", async () => {
    const script = new Map(
      scenarios.map((scenario) => [
        scenario.prompt,
        [
          { tool: "search_knowledge", args: { query: "무엇" } },
          { tool: null, args: {} },
        ] as readonly ToolChoice[],
      ]),
    );
    const report = await run(createScriptedSelector(script), 2);
    expect(report.diagnostics.stability).toBeLessThan(1);
    expect(report.warnings.join("\n")).toContain("흔들린다");
  });

  it("도구는 맞고 인자를 빠뜨리면 toolAccuracy만 높다", async () => {
    const script = new Map(
      scenarios.map((scenario) => [
        scenario.prompt,
        [
          scenario.expectedTool === null
            ? { tool: null, args: {} }
            : { tool: scenario.expectedTool, args: {} },
        ] as readonly ToolChoice[],
      ]),
    );
    const report = await run(createScriptedSelector(script), 1);
    expect(report.diagnostics.toolAccuracy).toBe(1);
    expect(
      report.metrics.selectionAccuracy,
      "필수 인자 검사가 꺼져 있다 — 빈 인자 호출이 만점을 받고 있다",
    ).toBeLessThan(1);
  });
});
