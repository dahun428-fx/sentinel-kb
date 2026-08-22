import { describe, expect, it } from "vitest";

import {
  BASELINE_EPSILON,
  checkBaselines,
  EVAL_EXIT_CODES,
  evaluateRegression,
  exitCodeFor,
  recheckReport,
} from "./baseline-guard.js";
import { makeReportFixture } from "./report-fixture.js";
import type { RetrievalMetrics } from "./report.js";

const BASE: RetrievalMetrics = { "recall@5": 0.8, mrr: 0.65 };

/**
 * **T-013 Acceptance 2의 절반이 여기다** (나머지 절반은 `check-baseline.cli.spec.ts`가
 * 실제 프로세스의 종료 코드로 확인한다). 순수 판정만 검사하면 "판정은 맞는데 CLI가
 * exit 0으로 끝내는" 조합을 놓치고, 프로세스만 검사하면 어느 지표가 왜 걸렸는지 알 수 없다.
 */
describe("checkBaselines — 양방향", () => {
  it("두 지표 모두 기준선 이상이면 위반이 없다", () => {
    expect(checkBaselines({ "recall@5": 0.9, mrr: 0.7 }, BASE)).toEqual([]);
  });

  it("동률은 통과다 — 기준선은 '이 밑으로 내려가면 안 되는 선'이다", () => {
    expect(checkBaselines({ ...BASE }, BASE)).toEqual([]);
  });

  it("recall만 낮아도 위반이다", () => {
    const violations = checkBaselines({ "recall@5": 0.79, mrr: 0.7 }, BASE);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ metric: "recall@5", value: 0.79, baseline: 0.8 });
    expect(violations[0]?.delta).toBeCloseTo(-0.01, 10);
  });

  /** mrr을 안 보는 가드는 recall만 지키는 가드다. specs/05는 둘 다 요구한다. */
  it("mrr만 낮아도 위반이다", () => {
    const violations = checkBaselines({ "recall@5": 0.95, mrr: 0.64 }, BASE);
    expect(violations.map((violation) => violation.metric)).toEqual(["mrr"]);
  });

  it("둘 다 낮으면 둘 다 신고한다 — 첫 위반에서 멈추지 않는다", () => {
    const violations = checkBaselines({ "recall@5": 0.1, mrr: 0.1 }, BASE);
    expect(violations.map((violation) => violation.metric).sort()).toEqual(["mrr", "recall@5"]);
  });

  it("epsilon은 부동소수 꼬리만 봐 준다 — 실측 가능한 최소 회귀(1e-4)는 삼키지 못한다", () => {
    expect(BASELINE_EPSILON).toBeLessThan(1e-4);
    expect(checkBaselines({ "recall@5": 0.7999, mrr: 0.65 }, BASE)).toHaveLength(1);
  });
});

describe("evaluateRegression — '떨어졌다'와 '잴 수 없었다'를 가른다", () => {
  it("신뢰 가능한 측정이 기준선 이상이면 evaluated·pass 둘 다 참이다", () => {
    const verdict = evaluateRegression({
      metrics: { "recall@5": 0.85, mrr: 0.7 },
      baselines: BASE,
      trusted: true,
      caseCount: 30,
    });
    expect(verdict).toMatchObject({ evaluated: true, pass: true, violations: [], reason: null });
  });

  it("신뢰 가능한 측정이 기준선 미달이면 evaluated:true, pass:false다", () => {
    const verdict = evaluateRegression({
      metrics: { "recall@5": 0.5, mrr: 0.3 },
      baselines: BASE,
      trusted: true,
      caseCount: 30,
    });
    expect(verdict.evaluated).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(2);
  });

  /** fake 임베딩으로 얻은 0.99가 기준선을 '통과'하면 그것이 이 태스크가 막으려는 거짓이다. */
  it("fake 임베딩이면 아무리 높아도 판정하지 않는다", () => {
    const verdict = evaluateRegression({
      metrics: { "recall@5": 1, mrr: 1 },
      baselines: BASE,
      trusted: false,
      caseCount: 30,
    });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("fake");
  });

  it("케이스가 0건이면 판정하지 않는다 — 0/0을 0.0으로 접어 회귀로 신고하지 않는다", () => {
    const verdict = evaluateRegression({
      metrics: { "recall@5": 0, mrr: 0 },
      baselines: BASE,
      trusted: true,
      caseCount: 0,
    });
    expect(verdict.evaluated).toBe(false);
    expect(verdict.reason).toContain("0건");
  });
});

describe("exitCodeFor", () => {
  it("통과 → 0, 하락 → 1, 판정 불가 → 78", () => {
    expect(exitCodeFor({ evaluated: true, pass: true, violations: [], reason: null })).toBe(0);
    expect(
      exitCodeFor({
        evaluated: true,
        pass: false,
        violations: [{ metric: "mrr", value: 0.1, baseline: 0.65, delta: -0.55 }],
        reason: null,
      }),
    ).toBe(1);
    expect(exitCodeFor({ evaluated: false, pass: false, violations: [], reason: "x" })).toBe(78);
  });

  it("종료 코드 상수가 sysexits 관례를 따른다", () => {
    expect(EVAL_EXIT_CODES).toEqual({ OK: 0, REGRESSED: 1, NOT_MEASURABLE: 78 });
  });
});

describe("recheckReport — 리포트가 스스로 주장하는 판정을 믿지 않는다", () => {
  it("리포트에 pass:true가 박혀 있어도 현재 기준선으로 다시 판정한다", () => {
    const fixture = makeReportFixture({ metrics: { "recall@5": 0.1, mrr: 0.1 } });
    expect(fixture.regression.pass).toBe(true); // 미끼
    const rechecked = recheckReport(fixture, BASE);
    expect(rechecked.regression.pass).toBe(false);
    expect(rechecked.regression.violations).toHaveLength(2);
  });

  it("사람이 올린 새 기준선이 과거 리포트에도 적용된다", () => {
    const fixture = makeReportFixture({ metrics: { "recall@5": 0.82, mrr: 0.7 } });
    expect(recheckReport(fixture, BASE).regression.pass).toBe(true);
    expect(recheckReport(fixture, { "recall@5": 0.85, mrr: 0.65 }).regression.pass).toBe(false);
  });

  it("신뢰 불가 리포트는 다시 판정해도 판정 불가다", () => {
    const fixture = makeReportFixture({ metrics: { "recall@5": 1, mrr: 1 }, trusted: false });
    expect(recheckReport(fixture, BASE).regression.evaluated).toBe(false);
  });
});
