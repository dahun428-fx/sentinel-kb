/**
 * 회귀 판정을 **양방향으로** 잠근다. 한쪽만 보면 "항상 통과하는 가드"나 "항상 막는 가드"가
 * 그대로 통과한다. 종료 코드 자체는 프로세스의 성질이므로 `check-baseline.cli.spec.ts`가
 * 실제 프로세스를 띄워 따로 본다.
 */
import { describe, expect, it } from "vitest";

import {
  BASELINE_EPSILON,
  checkBaselines,
  EVAL_EXIT_CODES,
  evaluateRegression,
  exitCodeFor,
  formatVerdict,
  recheckReport,
  toolsBaselines,
  UNRATIFIED_CONTRACT_NOTE,
} from "./baseline-guard.js";
import { makeReportFixture } from "./report-fixture.js";

const BASELINES = { selectionAccuracy: 0.85 };

describe("checkBaselines", () => {
  it("기준선보다 낮으면 위반이다", () => {
    const violations = checkBaselines({ selectionAccuracy: 0.7 }, BASELINES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ metric: "selectionAccuracy", value: 0.7, baseline: 0.85 });
    expect(violations[0]?.delta).toBeLessThan(0);
  });

  it("기준선보다 높으면 위반이 아니다", () => {
    expect(checkBaselines({ selectionAccuracy: 0.95 }, BASELINES)).toEqual([]);
  });

  it("동률은 통과다 — 선 위에 서 있는 것은 하락이 아니다", () => {
    expect(checkBaselines({ selectionAccuracy: 0.85 }, BASELINES)).toEqual([]);
  });

  it("EPSILON은 실제 회귀를 삼키지 못한다 — 반올림 자릿수(1e-4)보다 훨씬 작다", () => {
    expect(BASELINE_EPSILON).toBeLessThan(1e-4);
    expect(checkBaselines({ selectionAccuracy: 0.8499 }, BASELINES)).toHaveLength(1);
  });
});

describe("evaluateRegression", () => {
  it("신뢰할 수 있는 selector + 기준선 이상 → 판정했고 통과", () => {
    const verdict = evaluateRegression({
      metrics: { selectionAccuracy: 0.9 },
      baselines: BASELINES,
      trusted: true,
      scenarioCount: 20,
    });
    expect(verdict).toMatchObject({ evaluated: true, pass: true, reason: null });
  });

  it("신뢰할 수 있는 selector + 기준선 미만 → 판정했고 실패", () => {
    const verdict = evaluateRegression({
      metrics: { selectionAccuracy: 0.5 },
      baselines: BASELINES,
      trusted: true,
      scenarioCount: 20,
    });
    expect(verdict).toMatchObject({ evaluated: true, pass: false });
    expect(verdict.violations).toHaveLength(1);
  });

  /** **오라클은 정의상 1.0을 낸다.** 그 1.0이 통과로 읽히면 이 eval 전체가 거짓말이 된다. */
  it("selector가 실제 모델이 아니면 만점이어도 '통과'가 아니라 '판정 불가'다", () => {
    const verdict = evaluateRegression({
      metrics: { selectionAccuracy: 1 },
      baselines: BASELINES,
      trusted: false,
      scenarioCount: 20,
    });
    expect(verdict.evaluated, "자격증명 없이 판정하고 있다").toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("실제 모델");
  });

  it("시나리오 0건도 판정 불가다 — 0.0을 회귀로도 통과로도 읽지 않는다", () => {
    expect(
      evaluateRegression({
        metrics: { selectionAccuracy: 0 },
        baselines: BASELINES,
        trusted: true,
        scenarioCount: 0,
      }).evaluated,
    ).toBe(false);
  });
});

describe("exitCodeFor", () => {
  it("판정했고 통과 → 0", () => {
    expect(exitCodeFor({ evaluated: true, pass: true, violations: [], reason: null })).toBe(
      EVAL_EXIT_CODES.OK,
    );
  });

  it("판정했고 하락 → 1 (Acceptance 3)", () => {
    expect(exitCodeFor({ evaluated: true, pass: false, violations: [], reason: null })).toBe(1);
  });

  it("판정 불가 → 78. 0으로 끝내면 '판정 불가'가 '통과'로 읽힌다", () => {
    expect(exitCodeFor({ evaluated: false, pass: false, violations: [], reason: "이유" })).toBe(78);
  });
});

describe("recheckReport", () => {
  it("리포트에 박힌 낙관적 판정을 믿지 않고 현재 기준선으로 다시 잰다", () => {
    const fixture = makeReportFixture({ metrics: { selectionAccuracy: 0.1 } });
    expect(fixture.regression.pass).toBe(true); // 미끼
    const rechecked = recheckReport(fixture, BASELINES);
    expect(rechecked.regression.pass).toBe(false);
    expect(rechecked.baselines).toEqual(BASELINES);
  });
});

describe("formatVerdict", () => {
  it("계약 지문을 찍는다 — 다른 지문의 리포트끼리는 비교 대상이 아니다(G6)", () => {
    expect(formatVerdict(makeReportFixture())).toContain("계약 지문");
  });

  it("미비준 이탈 4건이 경고에 실리면 그대로 출력된다", () => {
    const report = { ...makeReportFixture(), warnings: [UNRATIFIED_CONTRACT_NOTE] };
    const text = formatVerdict(report);
    expect(text).toContain("미비준 이탈이 4건");
    expect(text).toContain("비준이 기준선 확정보다 먼저");
  });
});

describe("toolsBaselines", () => {
  it("파일의 tools 절만 꺼낸다", () => {
    expect(toolsBaselines({ tools: BASELINES })).toEqual(BASELINES);
  });
});
