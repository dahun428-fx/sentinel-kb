import { describe, expect, it } from "vitest";

import {
  buildDogfoodReport,
  DogfoodLogError,
  DogfoodWeekError,
  dogfoodReportFileName,
  isoWeekOf,
  isoWeekStart,
  parseDogfoodLog,
  summarizeDogfoodReport,
  TARGET_HITS_4W,
  TARGET_RECORDS_4W,
  trailingWeeks,
} from "./dogfood-report.js";

/**
 * T-024 Acceptance 3(집계 스크립트가 주간 리포트 JSON 출력)의 순수 함수 절반.
 * 프로세스 수준 판정은 `dogfood-report.cli.spec.ts`가 한다.
 */

const at = (iso: string): Date => new Date(iso);

describe("isoWeekOf — 연 경계에서 달력 연도와 갈린다", () => {
  // 달력 연도로 묶으면 아래 두 줄이 각각 엉뚱한 파일로 들어간다.
  // 값은 ISO 8601 정의에서 직접 나온 것이고 구현에서 역산하지 않았다.
  it.each([
    ["2026-01-01T00:00:00Z", "2026-W01"], // 목요일 = 그 주가 2026년 1주
    ["2026-08-17T00:00:00Z", "2026-W34"], // 월요일 (주의 시작)
    ["2026-08-23T23:59:59Z", "2026-W34"], // 일요일 (주의 끝)
    ["2026-08-24T00:00:00Z", "2026-W35"], // 다음 월요일
    ["2024-12-30T00:00:00Z", "2025-W01"], // 12월인데 **다음 해** 1주
    ["2027-01-03T00:00:00Z", "2026-W53"], // 1월인데 **지난 해** 53주
    ["2021-01-01T00:00:00Z", "2020-W53"],
    ["2020-01-02T00:00:00Z", "2020-W01"],
  ])("%s → %s", (iso, week) => {
    expect(isoWeekOf(at(iso))).toBe(week);
  });

  it("주의 7일이 전부 같은 주로 묶인다", () => {
    const monday = isoWeekStart("2026-W34");
    const weeks = new Set<string>();
    for (let day = 0; day < 7; day += 1) {
      weeks.add(isoWeekOf(new Date(monday.getTime() + day * 86_400_000)));
    }
    expect([...weeks]).toEqual(["2026-W34"]);
  });
});

describe("isoWeekStart", () => {
  it("주의 월요일 00:00Z를 준다", () => {
    expect(isoWeekStart("2026-W34").toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(isoWeekStart("2025-W01").toISOString()).toBe("2024-12-30T00:00:00.000Z");
  });

  it("53주가 있는 해와 없는 해를 구분한다", () => {
    // 2026-01-01이 목요일이라 2026년은 53주까지 있다. 2025년은 52주뿐이다.
    expect(isoWeekStart("2026-W53").toISOString()).toBe("2026-12-28T00:00:00.000Z");
    expect(() => isoWeekStart("2025-W53")).toThrow(DogfoodWeekError);
  });

  it("존재하지 않는 주를 조용히 옆 주로 바꾸지 않는다", () => {
    // 넘어가면 2026-W01을 2025-W53 이름으로 집계하게 된다.
    expect(() => isoWeekStart("2025-W53")).toThrow(DogfoodWeekError);
    expect(() => isoWeekStart("2026-W00")).toThrow(DogfoodWeekError);
    expect(() => isoWeekStart("2026-34")).toThrow(DogfoodWeekError);
    expect(() => isoWeekStart("26-W34")).toThrow(DogfoodWeekError);
  });
});

describe("trailingWeeks", () => {
  it("이번 주를 포함해 과거→현재 순으로 4주를 준다", () => {
    expect(trailingWeeks("2026-W34", 4)).toEqual(["2026-W31", "2026-W32", "2026-W33", "2026-W34"]);
  });

  it("연을 거슬러도 ISO 주 이름을 유지한다", () => {
    expect(trailingWeeks("2025-W02", 4)).toEqual(["2024-W51", "2024-W52", "2025-W01", "2025-W02"]);
  });
});

describe("parseDogfoodLog — 깨진 줄은 줄 번호를 달고 죽는다", () => {
  it("빈 줄만 건너뛴다", () => {
    const raw = [
      '{"ts":"2026-08-18T09:00:00Z","event":"search","results":3,"query":"nginx sse"}',
      "",
      '{"ts":"2026-08-18T11:00:00Z","event":"record","recordId":"r1","type":"incident"}',
      '{"ts":"2026-08-19T10:00:00Z","event":"hit","recordId":"r1"}',
      "",
    ].join("\n");
    expect(parseDogfoodLog(raw)).toHaveLength(3);
  });

  it.each([
    [2, "not json", "JSON이 아니다"],
    [2, "[1,2]", "객체 하나여야 한다"],
    [2, '{"event":"search","results":1}', "`ts`"],
    [2, '{"ts":"어제","event":"search","results":1}', "파싱되지 않는다"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"searched","results":1}', "`event`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"search"}', "`results`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"search","results":-1}', "`results`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"search","results":1.5}', "`results`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"hit"}', "`recordId`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"record","recordId":"r1"}', "`type`"],
    [2, '{"ts":"2026-08-18T09:00:00Z","event":"record","recordId":"r1","type":"note"}', "`type`"],
  ])("줄 %i: %s", (line, bad, fragment) => {
    const raw = `{"ts":"2026-08-17T00:00:00Z","event":"search","results":0}\n${bad}\n`;
    let thrown: unknown;
    try {
      parseDogfoodLog(raw);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DogfoodLogError);
    expect((thrown as DogfoodLogError).line).toBe(line);
    expect((thrown as DogfoodLogError).message).toContain(fragment);
    expect((thrown as DogfoodLogError).message).toContain(`:${String(line)} —`);
  });

  it("`results: 0`은 유효하다 — 0건 검색이야말로 재고 싶은 값이다", () => {
    const events = parseDogfoodLog('{"ts":"2026-08-18T09:00:00Z","event":"search","results":0}');
    expect(events[0]).toEqual({ ts: "2026-08-18T09:00:00Z", event: "search", results: 0 });
  });
});

const WEEK = "2026-W34";

/** 34주(08-17~08-23) 안팎을 섞은 코퍼스. 경계 밖 이벤트가 새어 들어오는지 본다. */
const CORPUS = parseDogfoodLog(
  [
    // 33주 — 이번 주엔 안 세지만 4주 누적엔 센다
    '{"ts":"2026-08-14T09:00:00Z","event":"record","recordId":"w33a","type":"incident"}',
    '{"ts":"2026-08-14T10:00:00Z","event":"hit","recordId":"w33a"}',
    // 30주 — 4주 창(31~34) 밖이다
    '{"ts":"2026-07-24T09:00:00Z","event":"record","recordId":"w30a","type":"divergence"}',
    // 34주
    '{"ts":"2026-08-17T00:00:00Z","event":"search","results":2,"taskId":"T-024"}',
    '{"ts":"2026-08-18T09:00:00Z","event":"search","results":0,"taskId":"T-024"}',
    '{"ts":"2026-08-19T09:00:00Z","event":"search","results":5}',
    '{"ts":"2026-08-19T11:00:00Z","event":"record","recordId":"w34a","type":"divergence"}',
    '{"ts":"2026-08-20T11:00:00Z","event":"record","recordId":"w34b","type":"divergence"}',
    '{"ts":"2026-08-21T11:00:00Z","event":"record","recordId":"w34c","type":"incident"}',
    '{"ts":"2026-08-22T11:00:00Z","event":"hit","recordId":"w34a"}',
    '{"ts":"2026-08-23T23:59:00Z","event":"hit","recordId":"w34a","note":"같은 레코드 재적중"}',
    // 35주 — 경계 바로 밖
    '{"ts":"2026-08-24T00:00:00Z","event":"record","recordId":"w35a","type":"incident"}',
  ].join("\n"),
);

describe("buildDogfoodReport", () => {
  const report = buildDogfoodReport(CORPUS, {
    week: WEEK,
    generatedAt: at("2026-08-24T03:00:00Z"),
  });

  it("주 경계를 월요일~일요일로 자른다", () => {
    expect(report.week).toBe(WEEK);
    expect(report.weekStart).toBe("2026-08-17");
    expect(report.weekEnd).toBe("2026-08-23");
  });

  it("기록 건수를 type별로 센다 (경계 밖 제외)", () => {
    expect(report.records).toEqual({
      total: 3,
      byType: { incident: 1, divergence: 2 },
    });
  });

  it("검색은 결과 유무로 가른다 — 0건 검색이 미스율의 분자다", () => {
    expect(report.searches).toEqual({
      total: 3,
      withResults: 2,
      zeroResult: 1,
      resultRate: 0.6667,
    });
  });

  it("검색이 0회면 resultRate는 null이다 (0%로 적으면 '다 실패'로 읽힌다)", () => {
    const empty = buildDogfoodReport([], { week: WEEK, generatedAt: at("2026-08-24T03:00:00Z") });
    expect(empty.searches).toEqual({
      total: 0,
      withResults: 0,
      zeroResult: 0,
      resultRate: null,
    });
  });

  it("적중은 건수로 세고 recordId는 중복을 접는다", () => {
    // 같은 레코드가 두 번 도움이 됐으면 적중은 2건이다. recordId 목록은 3건이 아니라 1종.
    expect(report.hits.total).toBe(2);
    expect(report.hits.recordIds).toEqual(["w34a"]);
  });

  it("4주 누적을 specs/00 목표에 대고 판정한다", () => {
    expect(report.trailing4Weeks.weeks).toEqual(["2026-W31", "2026-W32", "2026-W33", "2026-W34"]);
    // 33주 1건 + 34주 3건. 30주(w30a)와 35주(w35a)는 창 밖이다.
    expect(report.trailing4Weeks.records).toBe(4);
    expect(report.trailing4Weeks.hits).toBe(3);
    expect(report.trailing4Weeks.target).toEqual({
      records: TARGET_RECORDS_4W,
      hits: TARGET_HITS_4W,
    });
    expect(report.trailing4Weeks.meetsTarget).toBe(false);
  });

  it("두 목표를 모두 넘겨야 meetsTarget이다 — 한쪽만으로는 아니다", () => {
    const lines: string[] = [];
    for (let i = 0; i < TARGET_RECORDS_4W; i += 1) {
      lines.push(
        `{"ts":"2026-08-19T09:00:00Z","event":"record","recordId":"m${String(i)}","type":"incident"}`,
      );
    }
    const recordsOnly = buildDogfoodReport(parseDogfoodLog(lines.join("\n")), {
      week: WEEK,
      generatedAt: at("2026-08-24T03:00:00Z"),
    });
    expect(recordsOnly.trailing4Weeks.records).toBe(TARGET_RECORDS_4W);
    expect(recordsOnly.trailing4Weeks.hits).toBe(0);
    expect(recordsOnly.trailing4Weeks.meetsTarget).toBe(false);

    for (let i = 0; i < TARGET_HITS_4W; i += 1) {
      lines.push(`{"ts":"2026-08-19T10:00:00Z","event":"hit","recordId":"m${String(i)}"}`);
    }
    const both = buildDogfoodReport(parseDogfoodLog(lines.join("\n")), {
      week: WEEK,
      generatedAt: at("2026-08-24T03:00:00Z"),
    });
    expect(both.trailing4Weeks.meetsTarget).toBe(true);
  });

  it("sourceEvents는 창 밖까지 포함한 전체다 — 리포트가 로그를 얼마나 봤는지의 근거", () => {
    expect(report.sourceEvents).toBe(CORPUS.length);
    expect(report.sourceEvents).toBeGreaterThan(report.records.total);
  });

  it("generatedAt은 주입된 시계에서 온다 (리포트가 재현 가능해야 한다)", () => {
    expect(report.generatedAt).toBe("2026-08-24T03:00:00.000Z");
  });
});

describe("파일명·요약", () => {
  it("파일명이 T-024 스펙의 dogfood-{week}.json이다", () => {
    expect(dogfoodReportFileName("2026-W34")).toBe("dogfood-2026-W34.json");
  });

  it("요약 한 줄이 두 지표와 목표를 전부 말한다", () => {
    const line = summarizeDogfoodReport(
      buildDogfoodReport(CORPUS, { week: WEEK, generatedAt: at("2026-08-24T03:00:00Z") }),
    );
    expect(line).toContain("2026-W34");
    expect(line).toContain("기록 3건");
    expect(line).toContain("적중 2건");
    expect(line).toContain(`/${String(TARGET_RECORDS_4W)}`);
    expect(line).toContain(`/${String(TARGET_HITS_4W)}`);
    expect(line).toContain("미충족");
  });
});
