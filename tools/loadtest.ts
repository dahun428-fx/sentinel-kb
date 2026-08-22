/**
 * `/v1/search` 부하 측정기 (T-026, NFR-01 "검색 API p95 < 1.5s", 감사 B-4).
 *
 * ## 왜 autocannon이 아닌가
 * T-026 Scope는 autocannon을 지목한다. 실제로 깔아서 확인한 결과 **쓸 수 없다**:
 * autocannon의 백분위 집합은 `hdr-histogram-percentiles-obj`가 고정하고 있고
 * `[..., 90, 97.5, 99, ...]`로 **95가 없다.** 추가하는 옵션도 없다(autocannon@8.0.0 실측).
 * NFR-01과 이 태스크의 Acceptance는 둘 다 **p95**로 쓰여 있다. p97.5를 p95라고 적으면
 * 그건 지어낸 수치고, p90으로 대신하면 기준을 느슨하게 만든 것이다. 둘 다 하지 않는다.
 * → 백분위를 직접 계산한다. 대가로 의존성이 하나도 늘지 않는다(T-014 F-3의 문제의식과도 맞다).
 *
 * ## 백분위 계산법: nearest-rank (보간 없음)
 * `index = ceil(p/100 * N) - 1`. 보간하지 않는 이유는 **보간된 p95는 실제로 일어나지 않은
 * 지연**이라서다. 리포트에 남는 수치는 관측된 요청 하나의 실제 지연이어야 원인을 되짚을 수 있다.
 */

/** NFR-01의 검색 API p95 상한(ms). 이 값을 낮추는 것은 기준 완화라 스펙 개정 사항이다. */
export const NFR01_SEARCH_P95_MS = 1500;

export interface LatencySummary {
  readonly count: number;
  readonly errors: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * nearest-rank 백분위. `values`는 **오름차순 정렬되어 있어야 한다.**
 * 빈 배열이면 NaN이 아니라 0을 돌려준다 — 리포트에 NaN이 박히면 JSON이 깨진다.
 */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  if (!Number.isFinite(p) || p <= 0) return sortedAscending[0] ?? 0;
  const rank = Math.ceil((Math.min(p, 100) / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index] ?? 0;
}

/**
 * 리포트에 싣기 위한 반올림(소수 2자리). **`percentile` 안에서 하지 않는다** — 그쪽은
 * "관측된 값 그대로"가 계약이라 그 성질을 반올림으로 흐리지 않는다.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarize(latenciesMs: readonly number[], errors: number): LatencySummary {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    errors,
    meanMs: sorted.length === 0 ? 0 : round2(total / sorted.length),
    p50Ms: round2(percentile(sorted, 50)),
    p95Ms: round2(percentile(sorted, 95)),
    p99Ms: round2(percentile(sorted, 99)),
    maxMs: round2(sorted[sorted.length - 1] ?? 0),
  };
}

export interface LoadTestOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly durationMs: number;
  readonly connections: number;
  /** 테스트 주입용. 기본은 전역 fetch. */
  readonly fetchImpl?: typeof fetch;
  /** 테스트 주입용. 기본은 performance.now. */
  readonly now?: () => number;
}

export interface LoadTestResult extends LatencySummary {
  readonly durationMs: number;
  readonly connections: number;
  readonly requestsPerSecond: number;
}

/**
 * `connections`개의 가상 클라이언트가 각자 순차적으로 요청을 던진다. 총 벽시계 시간이
 * `durationMs`를 넘으면 각 클라이언트가 진행 중인 요청을 끝내고 멈춘다.
 *
 * 요청 속도를 인위적으로 조절하지 않는다(closed-loop). 열린 루프 부하기와 달리 서버가
 * 느려지면 요청도 느려지므로 **큐 대기가 지연에 섞이지 않는다** — 우리가 재려는 것은
 * 서버의 응답 지연이지 부하기의 백로그가 아니다.
 */
export async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? ((): number => performance.now());

  const latencies: number[] = [];
  let errors = 0;

  const start = now();
  const deadline = start + options.durationMs;

  const worker = async (): Promise<void> => {
    while (now() < deadline) {
      const began = now();
      try {
        const response = await doFetch(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(options.body),
        });
        // 본문을 끝까지 읽어야 지연이 정직하다. 헤더만 받고 끊으면 서버가 아직
        // 직렬화 중인 시간을 빼먹는다.
        await response.text();
        if (response.ok) latencies.push(now() - began);
        else errors += 1;
      } catch {
        errors += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, options.connections) }, () => worker()),
  );

  const elapsedMs = now() - start;
  const summary = summarize(latencies, errors);
  return {
    ...summary,
    durationMs: Math.round(elapsedMs),
    connections: options.connections,
    requestsPerSecond:
      elapsedMs <= 0 ? 0 : Math.round((summary.count / (elapsedMs / 1000)) * 100) / 100,
  };
}

export interface LoadTestReport extends LoadTestResult {
  readonly taskId: "T-026";
  readonly target: string;
  readonly nfr: "NFR-01";
  readonly thresholdMs: number;
  readonly pass: boolean;
  readonly percentileMethod: "nearest-rank";
  readonly ts: string;
}

export function buildReport(
  result: LoadTestResult,
  target: string,
  ts: string,
): LoadTestReport {
  return {
    ...result,
    taskId: "T-026",
    target,
    nfr: "NFR-01",
    thresholdMs: NFR01_SEARCH_P95_MS,
    // 요청이 한 건도 성공하지 않았으면 통과가 아니다. p95가 0이라고 초록을 띄우면
    // 그건 "빠르다"가 아니라 "아무것도 재지 않았다"다.
    pass: result.count > 0 && result.p95Ms < NFR01_SEARCH_P95_MS,
    percentileMethod: "nearest-rank",
    ts,
  };
}
