/**
 * T-026 부하 스크립트의 순수 부분 가드.
 *
 * 백분위 계산이 틀리면 리포트는 여전히 그럴듯한 숫자를 내고 **아무도 눈치채지 못한다.**
 * NFR-01 판정의 근거가 되는 수치라 여기서 잠근다.
 */
import { describe, expect, it } from "vitest";

import { buildReport, NFR01_SEARCH_P95_MS, percentile, runLoadTest, summarize } from "./loadtest.js";

describe("percentile — nearest-rank (T-026)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);

  it("1..100에서 p95는 95다 — 보간하지 않는다", () => {
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("항상 **실제로 관측된 값**을 돌려준다 (보간된 유령 지연을 만들지 않는다)", () => {
    const observed = [10, 20, 400];
    for (const p of [1, 25, 50, 75, 90, 95, 99, 100]) {
      expect(observed).toContain(percentile(observed, p));
    }
  });

  /**
   * nearest-rank의 경계. **표본이 적으면 p95는 꼬리를 못 본다** — 통계의 성질이지 버그가
   * 아니다. 여기서 잠가 두는 이유는 리포트를 읽는 사람이 "느린 요청이 있었는데 p95가
   * 멀쩡하네"를 버그로 오해하지 않게 하기 위해서다. 짧은 측정의 p95는 신뢰 구간이 넓다.
   */
  it("N=19에서 최악 1건은 p95에 잡힌다 (ceil(0.95*19)=19 → index 18)", () => {
    const latencies = [...Array.from({ length: 18 }, () => 10), 9000];
    expect(percentile(latencies, 95)).toBe(9000);
  });

  it("N=20에서 최악 1건은 p95에 잡히지 **않는다** — 1/20은 정확히 상위 5%다", () => {
    const latencies = [...Array.from({ length: 19 }, () => 10), 9000];
    expect(percentile(latencies, 95)).toBe(10);
    // 놓치는 것이 아니라 더 위쪽 백분위가 본다.
    expect(percentile(latencies, 99)).toBe(9000);
  });

  it("빈 표본에 NaN을 내지 않는다 — 리포트 JSON이 깨진다", () => {
    expect(percentile([], 95)).toBe(0);
    expect(Number.isNaN(percentile([], 95))).toBe(false);
  });
});

describe("summarize (T-026)", () => {
  it("정렬되지 않은 입력도 올바르게 요약한다", () => {
    const summary = summarize([300, 100, 200], 2);
    expect(summary).toMatchObject({ count: 3, errors: 2, p50Ms: 200, maxMs: 300, meanMs: 200 });
  });
});

describe("buildReport (T-026)", () => {
  const base = {
    count: 100,
    errors: 0,
    meanMs: 100,
    p50Ms: 100,
    p95Ms: 200,
    p99Ms: 300,
    maxMs: 400,
    durationMs: 10_000,
    connections: 10,
    requestsPerSecond: 10,
  };

  it("NFR-01 상한과 판정을 함께 남긴다 — 수치만 남기면 다음 사람이 기준을 다시 찾아야 한다", () => {
    const report = buildReport(base, "http://x/v1/search", "2026-08-23T00:00:00.000Z");
    expect(report.thresholdMs).toBe(NFR01_SEARCH_P95_MS);
    expect(report.nfr).toBe("NFR-01");
    expect(report.pass).toBe(true);
  });

  it("**성공 요청이 0건이면 통과가 아니다** — p95=0은 '빠르다'가 아니라 '재지 않았다'다", () => {
    const report = buildReport(
      { ...base, count: 0, errors: 50, p95Ms: 0 },
      "http://x/v1/search",
      "2026-08-23T00:00:00.000Z",
    );
    expect(report.pass).toBe(false);
  });

  it("상한을 넘으면 실패로 적는다", () => {
    const report = buildReport(
      { ...base, p95Ms: NFR01_SEARCH_P95_MS },
      "http://x/v1/search",
      "2026-08-23T00:00:00.000Z",
    );
    expect(report.pass).toBe(false);
  });
});

describe("runLoadTest (T-026)", () => {
  it("가짜 시계·가짜 fetch로 지연을 집계하고 실패를 errors로 센다", async () => {
    let clock = 0;
    const now = (): number => clock;
    let call = 0;
    const fetchImpl = ((): Promise<Response> => {
      call += 1;
      clock += 100; // 요청 1건당 100ms
      if (call === 3) return Promise.reject(new Error("boom"));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await runLoadTest({
      url: "http://x/v1/search",
      apiKey: "k",
      body: {},
      durationMs: 500,
      connections: 1,
      fetchImpl,
      now,
    });

    expect(result.count).toBe(4);
    expect(result.errors).toBe(1);
    expect(result.p95Ms).toBe(100);
  });
});
