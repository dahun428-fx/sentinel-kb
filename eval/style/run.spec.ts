/**
 * 러너 자체 검증 — T-034 Acceptance 1·2가 판정되는 자리다.
 *
 * 실 모델 없이 확인할 수 있는 것과 없는 것을 갈라 둔다.
 *   - **확인할 수 있다**: 글별 판정과 근거가 리포트에 남는가(Acceptance 1), 대조군을 놓친
 *     실행이 통과로 읽히지 않는가(Acceptance 2), 전문이 새지 않는가, 종료 판정이 서는가.
 *   - **확인할 수 없다**: 실제 모델이 우리 아티클을 몇 %로 집어내는가. 그건 자격증명이
 *     있어야 하고, 없으면 러너가 78로 거절한다(`run.cli.spec.ts`).
 *
 * fixture judge는 **본문만 보고** 답한다 — `origin`을 볼 수 있는 경로가 애초에 없다.
 */
import { describe, expect, it, vi } from "vitest";

import { blindCorpus } from "./blind.js";
import type { StylePiece } from "./corpus.js";
import { createFixtureStyleJudge, type StyleJudge, type StyleJudgeInput } from "./judge.js";
import type { PipelineOutcome } from "./metrics.js";
import { StyleReport } from "./report.js";
import { buildStyleReport, formatStyleVerdict, judgeAll } from "./run.js";

/** 본문에 심어 둔 표식으로만 답하는 fixture. 실제 판별기가 아니라 **러너를 흔드는 손**이다. */
const MARKER = "[[SLOP]]";

function markerJudge(): StyleJudge {
  return {
    ...createFixtureStyleJudge((input: StyleJudgeInput) => ({
      verdict: input.text.includes(MARKER) ? ("ai" as const) : ("human" as const),
      confidence: 4,
      reason: input.text.includes(MARKER) ? "상투적인 구성이다." : "구체적인 사건이 있다.",
    })),
    // 이 실행을 "측정"으로 읽히게 하려면 trusted가 필요하다. 게이트 자체는
    // `guard.spec.ts`가 따로 잠근다.
    trusted: true,
  };
}

function alwaysHumanJudge(): StyleJudge {
  return {
    ...createFixtureStyleJudge(() => ({
      verdict: "human" as const,
      confidence: 5,
      reason: "사람이 쓴 것 같다.",
    })),
    trusted: true,
  };
}

/** 생성 2 / 사람 3 / 대조군 2. 대조군과 생성분에만 표식이 있다. */
function corpus(): StylePiece[] {
  return [
    { origin: "generated", sourceRef: "ART-pattern-01", text: `아티클 본문 ${MARKER}` },
    { origin: "generated", sourceRef: "ART-pattern-02", text: "아티클 본문 2 — 표식 없음" },
    { origin: "human", sourceRef: "docs/analysis/T-004-POSTMORTEM.md", text: "사람 글 1" },
    { origin: "human", sourceRef: "docs/human-2.md", text: "사람 글 2" },
    { origin: "human", sourceRef: "docs/human-3.md", text: "사람 글 3" },
    { origin: "control", sourceRef: "eval/style/corpus.ts:CTL-01", text: `대조군 1 ${MARKER}` },
    { origin: "control", sourceRef: "eval/style/corpus.ts:CTL-02", text: `대조군 2 ${MARKER}` },
  ];
}

function outcome(overrides: Partial<PipelineOutcome> = {}): PipelineOutcome {
  return {
    articleId: "ART-pattern-01",
    accepted: true,
    rejection: null,
    lintPassed: true,
    lintViolationRules: [],
    factCheckViolations: 0,
    attempts: 1,
    styleSamples: 2,
    ...overrides,
  };
}

const NOW = new Date("2026-08-23T04:05:06.000Z");

async function report(judge: StyleJudge, pieces: StylePiece[] = corpus()) {
  const judged = await judgeAll(blindCorpus(pieces), judge);
  return buildStyleReport({
    judged,
    pipeline: [outcome()],
    judge,
    baselines: { discriminationAccuracy: 0.7 },
    blindSeed: "spec-seed",
    now: NOW,
    publicationRate: null,
  });
}

describe("judgeAll", () => {
  it("한 편에 한 번씩 부른다 — 묶어서 보내면 서로 비교해서 답한다", async () => {
    const judge = markerJudge();
    const spy = vi.spyOn(judge, "judge");

    await judgeAll(blindCorpus(corpus()), judge);

    expect(spy).toHaveBeenCalledTimes(7);
    for (const [call] of spy.mock.calls) {
      expect(Object.keys(call).sort()).toEqual(["itemId", "text"]);
    }
  });

  it("판정이 끝난 뒤에 origin을 다시 붙인다", async () => {
    const judged = await judgeAll(blindCorpus(corpus()), markerJudge());

    expect(judged).toHaveLength(7);
    expect(judged.filter((piece) => piece.origin === "control")).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ Acceptance 1
describe("리포트에 글별 판별 결과와 근거가 기록된다", () => {
  it("글마다 판정·정오·근거가 한 줄씩 남는다", async () => {
    const built = await report(markerJudge());

    expect(built.pieces).toHaveLength(7);
    for (const piece of built.pieces) {
      expect(piece.verdict).toMatch(/^(ai|human)$/u);
      expect(typeof piece.correct).toBe("boolean");
      expect(piece.reason.length).toBeGreaterThan(0);
      expect(piece.sourceRef.length).toBeGreaterThan(0);
    }
  });

  it("출처를 함께 남겨 판정 뒤에 되짚을 수 있다", async () => {
    const built = await report(markerJudge());
    const human = built.pieces.filter((piece) => piece.origin === "human");

    expect(human.map((piece) => piece.sourceRef).sort()).toEqual([
      "docs/analysis/T-004-POSTMORTEM.md",
      "docs/human-2.md",
      "docs/human-3.md",
    ]);
  });

  it("리포트 스키마를 만족한다 (.strict — 나중에 본문 필드를 끼워 넣으면 깨진다)", async () => {
    const built = await report(markerJudge());

    expect(() => StyleReport.parse(built)).not.toThrow();
  });

  it("본문 전문을 싣지 않는다 — 리포트는 커밋되고 PR에 붙는다", async () => {
    const built = await report(markerJudge());

    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain("아티클 본문");
    expect(serialized).not.toContain("사람 글 1");
  });

  it("콘솔 요약에도 글별 판정이 나온다", async () => {
    const text = formatStyleVerdict(await report(markerJudge()));

    expect(text).toContain("ITEM-01");
    expect(text).toContain("판별 정확도");
    expect(text).toContain("대조군 정확도");
  });
});

// ------------------------------------------------------------------ Acceptance 2
describe("대조군이 높은 판별 정확도로 걸러진다 (러너 자체 검증)", () => {
  it("표식을 읽는 judge는 대조군을 전부 집어낸다 → 판정이 선다", async () => {
    const built = await report(markerJudge());

    expect(built.metrics.controlAccuracy).toBe(1);
    expect(built.regression.evaluated).toBe(true);
  });

  it("대조군을 놓치는 judge의 리포트는 통과가 아니라 판정 불가다", async () => {
    const built = await report(alwaysHumanJudge());

    expect(built.metrics.controlAccuracy).toBe(0);
    // 전부 "human"이면 사람 글 3편이 다 맞아 정확도가 0.6으로 **낮게** 나온다.
    // 상한 0.7 아래라서, 게이트가 없으면 이 실행이 통과로 읽힌다. 그게 이 테스트가 막는 것이다.
    expect(built.metrics.discriminationAccuracy).toBe(0.6);
    expect(built.metrics.discriminationAccuracy).toBeLessThan(built.baselines.discriminationAccuracy);
    expect(built.regression.evaluated).toBe(false);
    expect(built.regression.pass).toBe(false);
  });

  it("한쪽으로만 답한 실행은 degenerate로 표시된다", async () => {
    const built = await report(alwaysHumanJudge());

    expect(built.metrics.degenerate).toBe(true);
  });
});

describe("경고 — 판정을 바꾸지 않고 읽는 법만 알려준다", () => {
  it("사람 글이 모자라면 경고하고 판정하지 않는다", async () => {
    const short = corpus().filter((piece) => piece.sourceRef !== "docs/human-3.md");

    const built = await report(markerJudge(), short);

    expect(built.corpus.human).toBe(2);
    expect(built.warnings.some((warning) => warning.includes("3편"))).toBe(true);
    expect(built.regression.evaluated).toBe(false);
  });

  it("발행률을 재지 못했다는 사실을 남긴다", async () => {
    const built = await report(markerJudge());

    expect(built.metrics.publicationRate).toBeNull();
    expect(built.warnings.some((warning) => warning.includes("발행률"))).toBe(true);
  });

  it("스타일 표본 0편으로 만든 아티클은 '문체'가 아니라 '표본 부재'를 잰 것일 수 있다", async () => {
    const judged = await judgeAll(blindCorpus(corpus()), markerJudge());
    const built = buildStyleReport({
      judged,
      pipeline: [outcome({ styleSamples: 0 })],
      judge: markerJudge(),
      baselines: { discriminationAccuracy: 0.7 },
      blindSeed: "spec-seed",
      now: NOW,
      publicationRate: null,
    });

    expect(built.warnings.some((warning) => warning.includes("표본"))).toBe(true);
  });

  it("반려된 초안은 조용히 사라지지 않고 경고로 남는다", async () => {
    const judged = await judgeAll(blindCorpus(corpus()), markerJudge());
    const built = buildStyleReport({
      judged,
      pipeline: [outcome({ accepted: false, rejection: "fact-check", factCheckViolations: 3 })],
      judge: markerJudge(),
      baselines: { discriminationAccuracy: 0.7 },
      blindSeed: "spec-seed",
      now: NOW,
      publicationRate: null,
    });

    expect(built.warnings.some((warning) => warning.includes("반려"))).toBe(true);
    expect(built.metrics.factCheckViolations).toBe(3);
    expect(built.warnings.some((warning) => warning.includes("팩트 대조"))).toBe(true);
  });

  it("사람 글 로더가 놓친 파일을 리포트에 남긴다", async () => {
    const judged = await judgeAll(blindCorpus(corpus()), markerJudge());
    const built = buildStyleReport({
      judged,
      pipeline: [outcome()],
      judge: markerJudge(),
      baselines: { discriminationAccuracy: 0.7 },
      blindSeed: "spec-seed",
      now: NOW,
      publicationRate: null,
      humanMissing: [{ path: "docs/gone.md", reason: "ENOENT" }],
    });

    expect(built.warnings.some((warning) => warning.includes("docs/gone.md"))).toBe(true);
  });
});

describe("리포트 메타", () => {
  it("날짜와 시드를 박아 판정을 재현할 수 있게 한다", async () => {
    const built = await report(markerJudge());

    expect(built.date).toBe("2026-08-23");
    expect(built.generatedAt).toBe(NOW.toISOString());
    expect(built.blindSeed).toBe("spec-seed");
    expect(built.baselines).toEqual({ discriminationAccuracy: 0.7 });
  });

  it("판정 순서 그대로 싣는다 — 출처별로 정렬하면 다음 배치를 사람이 미리 알게 된다", async () => {
    const built = await report(markerJudge());

    expect(built.pieces.map((piece) => piece.itemId)).toEqual([
      "ITEM-01",
      "ITEM-02",
      "ITEM-03",
      "ITEM-04",
      "ITEM-05",
      "ITEM-06",
      "ITEM-07",
    ]);
    expect(built.pieces.map((piece) => piece.origin)).not.toEqual(
      [...built.pieces.map((piece) => piece.origin)].sort(),
    );
  });
});
