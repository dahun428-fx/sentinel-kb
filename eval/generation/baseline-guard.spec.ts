/**
 * 회귀 판정의 순수 로직. 프로세스 수준 판정은 `check-baseline.cli.spec.ts`가 한다.
 * **양방향으로 건다** — 한쪽만 보면 "항상 통과" 또는 "항상 실패"하는 가드를 통과시킨다.
 */
import { describe, expect, it } from "vitest";

import {
  BASELINE_EPSILON,
  EVAL_EXIT_CODES,
  checkBaselines,
  evaluateRegression,
  exitCodeFor,
  formatVerdict,
  generationBaselines,
  recheckReport,
} from "./baseline-guard.js";
import { makeReportFixture } from "./report-fixture.js";
import type { GenerationMetrics } from "./report.js";

const BASELINES: GenerationMetrics = {
  citationRuleCheck: 1,
  faithfulness: 4,
  usefulness: 3.5,
};

function metrics(overrides: Partial<GenerationMetrics> = {}): GenerationMetrics {
  return { citationRuleCheck: 1, faithfulness: 4.5, usefulness: 4, ...overrides };
}

function evaluate(overrides: Partial<GenerationMetrics> = {}) {
  return evaluateRegression({
    metrics: metrics(overrides),
    baselines: BASELINES,
    generatorTrusted: true,
    judgeTrusted: true,
    answeredCount: 10,
  });
}

describe("checkBaselines", () => {
  it("기준선 이상이면 위반이 없다", () => {
    expect(checkBaselines(metrics(), BASELINES)).toEqual([]);
  });

  it("동률은 통과다 — 선 위에 서 있는 것은 하락이 아니다", () => {
    expect(checkBaselines(metrics({ faithfulness: 4, usefulness: 3.5 }), BASELINES)).toEqual([]);
  });

  it("지표마다 독립으로 판정한다", () => {
    const violations = checkBaselines(metrics({ usefulness: 3 }), BASELINES);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ metric: "usefulness", value: 3, baseline: 3.5 });
    expect(violations[0]?.delta).toBeCloseTo(-0.5, 10);
  });

  /** specs/05: "인용 룰체크 — 자동, **100% 요구**". 한 케이스만 어겨도 하락이다. */
  it("인용 룰체크는 0.9여도 하락이다 (100% 요구)", () => {
    expect(checkBaselines(metrics({ citationRuleCheck: 0.9 }), BASELINES)).toHaveLength(1);
  });

  it("EPSILON이 실제 회귀를 삼키지 않는다", () => {
    expect(checkBaselines(metrics({ citationRuleCheck: 0.9999 }), BASELINES)).toHaveLength(1);
    // 부동소수 꼬리만큼은 봐 준다.
    expect(
      checkBaselines(metrics({ citationRuleCheck: 1 - BASELINE_EPSILON / 2 }), BASELINES),
    ).toEqual([]);
  });

  it("모든 지표를 순회한다 — 하나만 보는 가드가 아니다", () => {
    const violations = checkBaselines(
      { citationRuleCheck: 0, faithfulness: 0, usefulness: 0 },
      BASELINES,
    );
    expect(violations.map((violation) => violation.metric).sort()).toEqual([
      "citationRuleCheck",
      "faithfulness",
      "usefulness",
    ]);
  });
});

describe("evaluateRegression — 판정 불가와 하락을 가른다", () => {
  it("전부 갖춰지고 기준선 이상이면 통과다", () => {
    expect(evaluate()).toMatchObject({ evaluated: true, pass: true });
    expect(exitCodeFor(evaluate())).toBe(EVAL_EXIT_CODES.OK);
  });

  it("기준선 하락은 exit 1이다", () => {
    const verdict = evaluate({ faithfulness: 2 });
    expect(verdict).toMatchObject({ evaluated: true, pass: false });
    expect(exitCodeFor(verdict)).toBe(EVAL_EXIT_CODES.REGRESSED);
  });

  /** **픽스처 만점이 기준선 통과로 읽히면 이 eval은 거짓말이 된다.** */
  it("생성기가 실제 모델이 아니면 만점이어도 판정 불가(78)다", () => {
    const verdict = evaluateRegression({
      metrics: { citationRuleCheck: 1, faithfulness: 5, usefulness: 5 },
      baselines: BASELINES,
      generatorTrusted: false,
      judgeTrusted: true,
      answeredCount: 10,
    });
    expect(verdict.evaluated).toBe(false);
    expect(exitCodeFor(verdict)).toBe(EVAL_EXIT_CODES.NOT_MEASURABLE);
  });

  it("judge가 실제 모델이 아니면 판정 불가(78)다", () => {
    const verdict = evaluateRegression({
      metrics: { citationRuleCheck: 1, faithfulness: 5, usefulness: 5 },
      baselines: BASELINES,
      generatorTrusted: true,
      judgeTrusted: false,
      answeredCount: 10,
    });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.reason).toContain("judge");
  });

  it("답을 낸 케이스가 0건이면 판정 불가(78)다 — 0/0을 회귀로 신고하지 않는다", () => {
    const verdict = evaluateRegression({
      metrics: { citationRuleCheck: 0, faithfulness: 0, usefulness: 0 },
      baselines: BASELINES,
      generatorTrusted: true,
      judgeTrusted: true,
      answeredCount: 0,
    });
    expect(verdict.evaluated).toBe(false);
    expect(exitCodeFor(verdict)).toBe(EVAL_EXIT_CODES.NOT_MEASURABLE);
  });
});

describe("recheckReport", () => {
  /** 리포트에 박힌 `pass:true`를 믿지 않는지 본다. */
  it("리포트의 주장이 아니라 현재 기준선으로 다시 판정한다", () => {
    const fixture = makeReportFixture({ metrics: { faithfulness: 1 } });
    expect(fixture.regression.pass).toBe(true);

    const rechecked = recheckReport(fixture, BASELINES);
    expect(rechecked.regression.pass).toBe(false);
    expect(rechecked.baselines).toEqual(BASELINES);
  });

  it("기준선을 올리면 과거 리포트가 그 선 아래로 읽힌다", () => {
    const fixture = makeReportFixture({ metrics: { usefulness: 3.6 } });
    expect(recheckReport(fixture, BASELINES).regression.pass).toBe(true);
    expect(
      recheckReport(fixture, { ...BASELINES, usefulness: 4 }).regression.pass,
    ).toBe(false);
  });
});

describe("generationBaselines / formatVerdict", () => {
  it("baselines 파일에서 generation 절만 꺼낸다", () => {
    expect(generationBaselines({ generation: BASELINES })).toEqual(BASELINES);
  });

  it("판정 불가 사유가 콘솔 요약에 그대로 나온다 — 조용히 지나가지 않는다", () => {
    const report = recheckReport(makeReportFixture({ judgeTrusted: false }), BASELINES);
    expect(formatVerdict(report)).toContain("판정 불가");
  });

  it("groundingViolation 건수가 요약에 나온다 (specs/03 §5)", () => {
    const report = makeReportFixture();
    expect(formatVerdict(report)).toContain("groundingViolation");
  });
});
