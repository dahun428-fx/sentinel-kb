/**
 * 러너 집계. **실제 모델 없이** 답변기·judge를 주입해 지표·경고·판정 경로를 전부 때린다.
 *
 * 인용 룰체크가 `packages/core`의 `verifyAnswerCitations`를 그대로 쓰므로, 여기서 재는 것은
 * "프로덕션 검증기가 답변에서 위반을 잡았을 때 러너가 그것을 지표로 옮기는가"다.
 */
import { describe, expect, it } from "vitest";

import type { AnswerFn, AnswerResult, FetchSourcesFn } from "./answerer.js";
import type { GenerationCase } from "./cases.js";
import { createFixtureJudge, type Judge } from "./judge.js";
import type { CaseJudgement, GenerationMetrics, ModelProvenance } from "./report.js";
import { runGenerationEval } from "./run.js";

const BASELINES: GenerationMetrics = { citationRuleCheck: 1, faithfulness: 4, usefulness: 3.5 };
const NOW = new Date("2026-08-23T12:00:00.000Z");
const CITATION = "[REC-68f0c4a1b2c3d4e5f6a7b8c9#resolution]";

const TRUSTED_GENERATOR: ModelProvenance = {
  provider: "core-api",
  model: "test-model",
  trusted: true,
};

function grounded(caseId: string, query = "커넥션 풀 고갈"): GenerationCase {
  return { caseId, kind: "grounded", query, boundary: "테스트" };
}

function irrelevant(caseId: string): GenerationCase {
  return { caseId, kind: "irrelevant", query: "오늘 점심 뭐 먹지", boundary: "Eval 2-c" };
}

function found(answer: string): AnswerResult {
  return {
    found: true,
    answer,
    citations: [
      { recordId: "68f0c4a1b2c3d4e5f6a7b8c9", section: "resolution", title: "커넥션 풀", score: 0.03 },
    ],
    allowedCitations: [CITATION],
  };
}

const NOT_FOUND: AnswerResult = { found: false, answer: "", citations: [], allowedCitations: [] };

function answerer(byCaseQuery: (query: string) => AnswerResult): AnswerFn {
  return (query: string) => Promise.resolve(byCaseQuery(query));
}

const NO_SOURCES: FetchSourcesFn = () => Promise.resolve([]);

/** 실제 judge인 척하는 픽스처. `trusted:true`를 줘야 판정 경로까지 볼 수 있다. */
function trustedJudge(scores: CaseJudgement): Judge {
  return {
    provenance: { provider: "anthropic", model: "test-judge", trusted: true },
    judge: () => Promise.resolve(scores),
  };
}

const GOOD_JUDGE = trustedJudge({ faithfulness: 5, usefulness: 4, note: "좋다" });

async function run(
  cases: GenerationCase[],
  answer: AnswerFn,
  judge: Judge = GOOD_JUDGE,
  generator: ModelProvenance = TRUSTED_GENERATOR,
) {
  return runGenerationEval({
    cases,
    answer,
    fetchSources: NO_SOURCES,
    judge,
    generator,
    baselines: BASELINES,
    now: NOW,
    expectedCaseCount: cases.length,
  });
}

describe("runGenerationEval — 인용 룰체크 (specs/05 Eval 2-a)", () => {
  it("모든 답변이 인용 규칙을 지키면 1.0이다", async () => {
    const report = await run(
      [grounded("A"), grounded("B")],
      answerer(() => found(`풀 상한을 올렸다 ${CITATION}.`)),
    );

    expect(report.metrics.citationRuleCheck).toBe(1);
    expect(report.regression).toMatchObject({ evaluated: true, pass: true });
  });

  /** **T-019 M5b가 지표에 나타나는 지점.** 인용 마커 0개 답변은 통과가 아니다. */
  it("인용 마커가 없는 답변은 룰체크 실패로 잡힌다", async () => {
    const report = await run(
      [grounded("A"), grounded("B")],
      answerer((query) => (query === "커넥션 풀 고갈" ? found("풀 상한을 올렸다.") : found(`올렸다 ${CITATION}.`))),
    );

    expect(report.metrics.citationRuleCheck).toBe(0);
    expect(report.diagnostics.groundingViolations).toBe(2);
    expect(report.regression.pass).toBe(false);
  });

  /** **지어낸 recordId 통과 뮤테이션이 여기서 죽는다** (Acceptance 1). */
  it("컨텍스트에 없는 ID를 인용한 답변은 실패로 잡히고 리포트에 ID가 남는다", async () => {
    const invented = "[REC-68f0c4a1b2c3d4e5f6a7b8ff#resolution]";
    const report = await run([grounded("A")], answerer(() => found(`올렸다 ${invented}.`)));

    expect(report.metrics.citationRuleCheck).toBe(0);
    expect(report.cases[0]?.unknownCitations).toEqual([invented]);
    expect(report.cases[0]?.unknownCitationSentences).toBe(1);
    expect(report.diagnostics.unknownCitations).toBe(1);
    expect(report.warnings.join("\n")).toContain("컨텍스트에 없는 인용 ID");
  });

  it("일부만 어기면 비율로 잡힌다 — 0/1로 접지 않는다", async () => {
    let call = 0;
    const report = await run(
      [grounded("A"), grounded("B"), grounded("C"), grounded("D")],
      answerer(() => {
        call += 1;
        return found(call === 1 ? "인용이 없다." : `올렸다 ${CITATION}.`);
      }),
    );

    expect(report.metrics.citationRuleCheck).toBe(0.75);
  });
});

describe("runGenerationEval — 임계값 시나리오 (specs/05 Eval 2-c)", () => {
  it("무관한 쿼리가 found:false면 통과로 집계된다", async () => {
    const report = await run(
      [grounded("A"), irrelevant("T1")],
      answerer((query) => (query === "오늘 점심 뭐 먹지" ? NOT_FOUND : found(`올렸다 ${CITATION}.`))),
    );

    expect(report.diagnostics.thresholdScenarioCount).toBe(1);
    expect(report.diagnostics.thresholdScenarioPass).toBe(1);
    // 케이스 수가 커밋된 집합과 다르다는 경고는 붙지만, **2-c 위반 경고는 없어야** 한다.
    expect(report.warnings.join("\n")).not.toContain("Eval 2(c) 위반");
  });

  it("무관한 쿼리가 답을 만들면 경고가 붙는다 — 지표보다 먼저 읽히게", async () => {
    const report = await run(
      [irrelevant("T1")],
      answerer(() => found(`올렸다 ${CITATION}.`)),
    );

    expect(report.diagnostics.thresholdScenarioPass).toBe(0);
    expect(report.warnings.join("\n")).toContain("Eval 2(c) 위반");
  });

  /** found:false는 답이 없으므로 룰체크의 **분모에 들어가지 않는다.** */
  it("found:false 케이스는 룰체크 분모에서 빠진다 — 게이트가 지표를 깎지 않는다", async () => {
    const report = await run(
      [grounded("A"), irrelevant("T1"), irrelevant("T2")],
      answerer((query) => (query === "커넥션 풀 고갈" ? found(`올렸다 ${CITATION}.`) : NOT_FOUND)),
    );

    expect(report.diagnostics.answeredCount).toBe(1);
    expect(report.metrics.citationRuleCheck).toBe(1);
    expect(report.cases.filter((item) => item.citationRuleCheck === null)).toHaveLength(2);
  });

  it("근거가 있어야 할 케이스가 found:false면 경고가 붙는다", async () => {
    const report = await run([grounded("A")], answerer(() => NOT_FOUND));
    expect(report.warnings.join("\n")).toContain("found:false");
  });
});

describe("runGenerationEval — judge (specs/05 Eval 2-b)", () => {
  it("judge 점수의 평균이 지표가 된다", async () => {
    let call = 0;
    const judge: Judge = {
      provenance: { provider: "anthropic", model: "test-judge", trusted: true },
      judge: () => {
        call += 1;
        return Promise.resolve({ faithfulness: call === 1 ? 5 : 4, usefulness: 4, note: "" });
      },
    };
    const report = await run(
      [grounded("A"), grounded("B")],
      answerer(() => found(`올렸다 ${CITATION}.`)),
      judge,
    );

    expect(report.metrics.faithfulness).toBe(4.5);
    expect(report.metrics.usefulness).toBe(4);
  });

  it("답이 없는 케이스는 judge를 부르지 않는다", async () => {
    let calls = 0;
    const judge: Judge = {
      provenance: { provider: "anthropic", model: "test-judge", trusted: true },
      judge: () => {
        calls += 1;
        return Promise.resolve({ faithfulness: 5, usefulness: 5, note: "" });
      },
    };
    await run([irrelevant("T1")], answerer(() => NOT_FOUND), judge);

    expect(calls).toBe(0);
  });

  /** 픽스처 judge의 수치는 판정 대상이 아니다. */
  it("픽스처 judge로 돌리면 판정 불가다", async () => {
    const report = await run(
      [grounded("A")],
      answerer(() => found(`올렸다 ${CITATION}.`)),
      createFixtureJudge(),
    );

    expect(report.judge.trusted).toBe(false);
    expect(report.regression.evaluated).toBe(false);
  });
});

describe("runGenerationEval — 리포트 형상", () => {
  it("답변 본문이 리포트에 실리지 않는다 — 길이만 남는다", async () => {
    const answer = `커넥션 풀 상한을 20으로 올렸다 ${CITATION}.`;
    const report = await run([grounded("A")], answerer(() => found(answer)));

    expect(JSON.stringify(report)).not.toContain("커넥션 풀 상한을 20으로 올렸다");
    expect(report.cases[0]?.answerChars).toBe(answer.length);
  });

  it("날짜와 생성 시각이 같은 시계에서 나온다", async () => {
    const report = await run([grounded("A")], answerer(() => found(`올렸다 ${CITATION}.`)));

    expect(report.date).toBe("2026-08-23");
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it("케이스 수가 기대와 다르면 경고가 붙는다 — 막지는 않는다", async () => {
    const report = await runGenerationEval({
      cases: [grounded("A")],
      answer: answerer(() => found(`올렸다 ${CITATION}.`)),
      fetchSources: NO_SOURCES,
      judge: GOOD_JUDGE,
      generator: TRUSTED_GENERATOR,
      baselines: BASELINES,
      now: NOW,
      expectedCaseCount: 15,
    });

    expect(report.warnings.join("\n")).toContain("케이스가 1건이다");
  });
});
