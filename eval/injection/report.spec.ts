/**
 * 리포트의 성질을 잠근다. 둘이 중요하다.
 *
 * 1. **기준선 키가 `eval/baselines.json`과 글자 그대로 같은가.** 어긋나면 가드가 키를 못 찾아
 *    조용히 통과한다 — 항상 통과하는 가드는 없는 가드보다 나쁘다(`retrieval/report.ts`의 그 이유).
 * 2. **리포트에 페이로드가 새지 않는가.** 리포트는 커밋되고 PR 본문에 붙는다. 거기에 동작하는
 *    인젝션 문자열이 실리면 이 eval이 스스로 페이로드 배포 채널이 된다.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { corpusBodies } from "./corpus.js";
import { judgeAvailability, runDetection, runExclusion } from "./defenses.js";
import { BASELINES_URL, InjectionBaselinesFile } from "./baselines.js";
import { InjectionReport, injectionReportFileName, toReportDate } from "./report.js";
import { buildInjectionReport, countRuleHits, formatInjectionVerdict, stoppedCaseIds } from "./run.js";

const baselinesRaw: unknown = JSON.parse(readFileSync(BASELINES_URL, "utf8"));

function makeReport(): InjectionReport {
  const detection = runDetection();
  const exclusion = runExclusion(detection);
  return buildInjectionReport({
    detection,
    exclusion,
    judge: judgeAvailability({}),
    clausePresent: true,
    baselines: InjectionBaselinesFile.parse(baselinesRaw).injection,
    now: new Date("2026-01-02T03:04:05.000Z"),
  });
}

describe("기준선 연결", () => {
  it("`eval/baselines.json`의 injection 절을 그대로 파싱한다", () => {
    const parsed = InjectionBaselinesFile.parse(baselinesRaw);

    expect(parsed.injection.defenseRate).toBe(1);
  });

  it("리포트가 비교에 쓴 기준선 사본을 싣는다 — 리포트만으로 판정을 재현할 수 있다", () => {
    expect(makeReport().baselines).toEqual({ defenseRate: 1 });
  });
});

describe("리포트 스키마", () => {
  it("실제 산출물이 스키마를 통과한다", () => {
    expect(() => InjectionReport.parse(makeReport())).not.toThrow();
  });

  it("파일명이 specs/05 규약(`YYYY-MM-DD-injection.json`)을 따른다", () => {
    expect(injectionReportFileName(toReportDate(new Date("2026-01-02T23:59:59.000Z")))).toBe(
      "2026-01-02-injection.json",
    );
  });

  it("세 방어선이 끝까지 **따로** 실린다 — 하나의 수치로 접히지 않는다", () => {
    const { defenses } = makeReport();

    expect(defenses.detection.measured).toBe(true);
    expect(defenses.exclusion.measured).toBe(true);
    expect(defenses.promptResistance.measured).toBe(false);
    // 방어율이 점추정이 아니라 구간인 것이 이 리포트의 요점이다.
    expect(makeReport().metrics.defenseRateLowerBound).toBeLessThanOrEqual(
      makeReport().metrics.defenseRateUpperBound,
    );
  });

  it("제외율의 분모는 **플래그된 청크**다 — 미탐이 제외 성적을 올리지 못한다", () => {
    const { exclusion } = makeReport().defenses;

    expect(exclusion.flaggedChunkCount).toBeLessThan(exclusion.chunkCount);
    expect(exclusion.rate).toBe(
      exclusion.excludedChunkCount / Math.max(1, exclusion.flaggedChunkCount),
    );
  });

  it("판정 불가는 `evaluated:false`로 남는다 — `pass:true`로 접히지 않는다", () => {
    const { regression } = makeReport();

    expect(regression.evaluated).toBe(false);
    expect(regression.pass).toBe(false);
  });

  it("미탐과 판정 불가가 경고로 남는다", () => {
    const warnings = makeReport().warnings.join("\n");

    expect(warnings).toContain("방어선 1(탐지)");
    expect(warnings).toContain("방어선 3(프롬프트 내성)");
  });
});

describe("페이로드 유출 금지", () => {
  it("리포트 JSON 어디에도 페이로드 본문이 없다", () => {
    const serialized = JSON.stringify(makeReport());
    const leaked = corpusBodies().filter((body) => serialized.includes(body));

    expect(leaked).toEqual([]);
  });

  it("콘솔 요약에도 페이로드 본문이 없다", () => {
    const text = formatInjectionVerdict(makeReport());
    const leaked = corpusBodies().filter((body) => text.includes(body));

    expect(leaked).toEqual([]);
  });

  it("재현 좌표(caseId·axis)는 남는다 — 본문 없이도 레포 안에서 재현 가능하다", () => {
    const { cases } = makeReport();

    expect(cases.detection.map((entry) => entry.caseId)).toContain("INJ-10");
    expect(cases.detection.every((entry) => entry.axis.length > 0)).toBe(true);
  });
});

describe("집계 함수", () => {
  it("규칙 id별 건수를 센다 (T-004 F-3의 사용처)", () => {
    const hits = countRuleHits([
      { caseId: "a", axis: "direct-command-ko", language: "ko", overlap: [], sections: [], flagged: true, rules: ["r1", "r2"], missingRules: [] },
      { caseId: "b", axis: "direct-command-en", language: "en", overlap: [], sections: [], flagged: true, rules: ["r1"], missingRules: [] },
    ]);

    expect(hits).toEqual({ r1: 2, r2: 1 });
  });

  it("한 섹션이라도 프롬프트에 닿으면 그 케이스는 막힌 것이 아니다", () => {
    const stopped = stoppedCaseIds({
      cases: [
        { chunkId: "a#1", caseId: "a", axis: "direct-command-ko", section: "symptom", flagged: true, excluded: true, reachedPrompt: false },
        { chunkId: "a#2", caseId: "a", axis: "direct-command-ko", section: "resolution", flagged: false, excluded: false, reachedPrompt: true },
        { chunkId: "b#1", caseId: "b", axis: "direct-command-en", section: "symptom", flagged: true, excluded: true, reachedPrompt: false },
      ],
      controlSurvived: true,
      context: { chunks: [], excluded: [] },
      rendered: "",
    });

    expect(stopped).toEqual(["b"]);
  });
});
