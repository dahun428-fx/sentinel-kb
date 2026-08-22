/**
 * `pnpm loadtest` 진입점 (T-026). `/v1/search` p95를 재서 `eval/reports/`에 남긴다.
 *
 * 대상은 **compose로 띄운 스택**이다. nginx 경유(`http://localhost:8080/v1/search`)로 재면
 * 프록시 오버헤드까지 포함한 수치가 나오고, 그쪽이 NFR-01이 말하는 "검색 API"에 가깝다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReport, runLoadTest } from "./loadtest.js";

const EXIT_CONFIG_ERROR = 78; // EX_CONFIG — env 오설정
const EXIT_THRESHOLD_MISS = 1; // 측정은 됐는데 NFR-01 미달

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `API_KEYS`의 첫 항목에서 키 부분만 뽑는다. 형식은 `<key>:<projectSlug>`. */
function firstApiKey(raw: string | undefined): string | undefined {
  const first = raw?.split(",")[0]?.trim();
  const key = first?.split(":")[0]?.trim();
  return key !== undefined && key.length > 0 ? key : undefined;
}

async function main(): Promise<void> {
  const env = process.env;

  const baseUrl = (
    env["LOADTEST_URL"]?.trim() ??
    env["EVAL_CORE_API_URL"]?.trim() ??
    `http://localhost:${env["CORE_API_PORT"]?.trim() ?? "3001"}`
  ).replace(/\/+$/, "");

  const apiKey = env["LOADTEST_API_KEY"]?.trim() ?? firstApiKey(env["API_KEYS"]);
  if (apiKey === undefined) {
    console.error(
      "[loadtest] LOADTEST_API_KEY도 API_KEYS도 없다 — /v1/search는 Bearer를 요구한다 (NFR-04).",
    );
    process.exitCode = EXIT_CONFIG_ERROR;
    return;
  }

  const target = `${baseUrl}/v1/search`;
  const durationMs = positiveInt(env["LOADTEST_DURATION_SECONDS"], 10) * 1000;
  const connections = positiveInt(env["LOADTEST_CONNECTIONS"], 10);

  console.error(
    `[loadtest] ${target} — ${String(durationMs / 1000)}s, 동시 ${String(connections)}`,
  );

  const result = await runLoadTest({
    url: target,
    apiKey,
    // 고정 질의를 쓴다. 질의마다 난이도가 달라지면 실행 간 비교가 불가능해진다.
    body: { query: "nginx SSE 버퍼링으로 스트리밍이 끊긴다", limit: 8 },
    durationMs,
    connections,
  });

  const ts = new Date().toISOString();
  const report = buildReport(result, target, ts);

  const reportsDir = join(repoRoot, "eval", "reports");
  const filePath = join(reportsDir, `loadtest-${ts.replace(/[:.]/g, "-")}.json`);
  const latestPath = join(reportsDir, "loadtest-latest.json");
  mkdirSync(dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(filePath, serialized);
  writeFileSync(latestPath, serialized);

  console.log(serialized.trimEnd());
  console.error(`[loadtest] 리포트: ${filePath}`);

  if (!report.pass) {
    console.error(
      `[loadtest] NFR-01 미달 또는 미측정: p95=${String(report.p95Ms)}ms, ` +
        `성공 ${String(report.count)}건 / 실패 ${String(report.errors)}건 ` +
        `(상한 ${String(report.thresholdMs)}ms)`,
    );
    process.exitCode = EXIT_THRESHOLD_MISS;
  }
}

await main();
