import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { BASELINES_URL, readBaselines } from "./baselines.js";
import { QUERY_KINDS } from "./query-kind.js";
import { makeReportFixture } from "./report-fixture.js";
import {
  ByQueryKind,
  RetrievalReport,
  RETRIEVAL_METRIC_KEYS,
  RETRIEVAL_REPORT_DIR,
  RETRIEVAL_REPORT_FILE_PATTERN,
  retrievalReportFileName,
  toReportDate,
} from "./report.js";

/**
 * **T-013 Acceptance 3이 판정되는 곳이다.** specs/05가 리포트에 요구하는 것은 셋이고,
 * 셋 다 여기서 실제 파일·실제 상수에 대고 단언한다 — 문장을 옮겨 적은 주석이 아니라.
 */
describe("리포트가 specs/05의 스키마와 일치한다", () => {
  it("파일명이 `eval/reports/YYYY-MM-DD-retrieval.json`이다", () => {
    expect(RETRIEVAL_REPORT_DIR).toBe("eval/reports");
    const name = retrievalReportFileName("2026-08-23");
    expect(name).toBe("2026-08-23-retrieval.json");
    expect(RETRIEVAL_REPORT_FILE_PATTERN.test(name)).toBe(true);
  });

  it("날짜 형식이 아니면 파일명을 만들지 않는다", () => {
    expect(() => retrievalReportFileName("2026-8-3")).toThrow();
    expect(() => retrievalReportFileName("20260823")).toThrow();
  });

  it("파일명 날짜는 UTC로 뽑는다 — 로컬 타임존에 따라 하루 밀리지 않는다", () => {
    // KST 09:00 = UTC 00:00. 로컬 기준으로 뽑으면 실행 위치에 따라 날짜가 갈린다.
    expect(toReportDate(new Date("2026-08-23T00:00:00.000Z"))).toBe("2026-08-23");
    expect(toReportDate(new Date("2026-08-23T23:59:59.999Z"))).toBe("2026-08-23");
  });

  it("지표가 specs/05의 Recall@5·MRR 둘이다", () => {
    expect([...RETRIEVAL_METRIC_KEYS]).toEqual(["recall@5", "mrr"]);
  });

  /**
   * 이 단언이 회귀 가드의 생명줄이다. 리포트 키와 기준선 키가 어긋나면
   * `checkBaselines`는 비교할 것을 못 찾아 **조용히 통과한다** — 있다고 믿게 만드는 가드가
   * 없는 가드보다 나쁘다. 한쪽이 바뀌면 여기서 죽는다.
   */
  it("리포트 지표 키가 eval/baselines.json의 retrieval 키와 글자 그대로 같다", async () => {
    const raw: unknown = JSON.parse(await readFile(BASELINES_URL, "utf8"));
    const retrieval = (raw as { retrieval: Record<string, number> }).retrieval;
    expect(Object.keys(retrieval).sort()).toEqual([...RETRIEVAL_METRIC_KEYS].sort());
  });

  it("기준선 파일을 스키마로 읽을 수 있다 (M2 기준선 0.80 / 0.65)", async () => {
    const baselines = await readBaselines();
    expect(baselines.retrieval["recall@5"]).toBe(0.8);
    expect(baselines.retrieval.mrr).toBe(0.65);
  });

  it("리포트 본문이 스키마를 만족한다", () => {
    expect(() => RetrievalReport.parse(makeReportFixture())).not.toThrow();
  });

  it("스키마에 없는 필드는 거부한다 — 리포트 형상이 조용히 넓어지지 않는다", () => {
    const report = { ...makeReportFixture(), note: "덧붙임" };
    expect(() => RetrievalReport.parse(report)).toThrow();
  });

  it("`k`는 5로 못박혀 있다 — 지표 이름과 컷오프가 어긋날 수 없다", () => {
    const fixture = makeReportFixture();
    const drifted = { ...fixture, config: { ...fixture.config, k: 3 } };
    expect(() => RetrievalReport.parse(drifted)).toThrow();
  });

  it("byQueryKind의 키가 QUERY_KINDS와 정확히 같다 — 종류가 늘면 여기서 죽는다", () => {
    expect(Object.keys(ByQueryKind.shape).sort()).toEqual([...QUERY_KINDS].sort());
  });

  it("판정 불가와 통과를 구분하는 필드가 있다", () => {
    const fixture = makeReportFixture();
    expect(fixture.regression).toHaveProperty("evaluated");
    expect(fixture.regression).toHaveProperty("pass");
    expect(fixture.embedding).toHaveProperty("trusted");
  });
});
