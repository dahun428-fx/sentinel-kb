/**
 * 포트폴리오 리포트 생성 (T-028 Acceptance 2·3).
 *
 * ```bash
 * pnpm exec tsx tools/portfolio-report.cli.ts                  # eval/reports/ 에 쓴다
 * pnpm exec tsx tools/portfolio-report.cli.ts --out-dir=/tmp/x # 다른 곳에 쓴다
 * ```
 *
 * 두 가지를 낸다.
 *
 * 1. **루프 지표** — `eval/loop-log.jsonl` → `portfolio-loop-metrics.{json,md}`.
 *    원천이 레포 안에 있으므로 언제나 나온다.
 * 2. **eval 그래프 3종** — `eval/reports/YYYY-MM-DD-{kind}.json` → `portfolio-eval-{kind}.svg`.
 *    원천이 **없다.** 없으면 없는 대로 그린다.
 *
 * ## 종료 코드
 * | 코드 | 뜻 |
 * |---|---|
 * | `0` | 루프 지표 + 그래프 3종 전부 실측 데이터로 그렸다 |
 * | `78` | 루프 지표는 냈으나 그래프 중 하나 이상이 **리포트 0건**이다 |
 * | `70` | 원천이 깨졌다 (JSONL 파싱 실패 등) |
 *
 * `78`(EX_CONFIG)은 이 레포에서 **"잴 수 없으면 거절한다"**의 정본 신호다
 * (`pnpm eval:tools`·`pnpm eval:generation`·`pnpm eval:injection`이 같은 코드를 쓴다).
 * 포트폴리오 산출물이 그 규약에서 빠지면, 지표가 없는 상태가 **그래프상 0으로** 보이게 되고
 * 그것은 "재서 0이 나왔다"와 구별되지 않는다. 이 CLI는 그 구별을 종료 코드로 강제한다.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABSENT_REASONS,
  buildLoopMetrics,
  collectEvalSeries,
  EVAL_REPORT_DIR,
  evalSvgFileName,
  GRAPH_KINDS,
  LOOP_LOG_PATH,
  LOOP_METRICS_JSON,
  LOOP_METRICS_MD,
  parseLoopLog,
  renderEvalSvg,
  renderLoopMetricsTable,
  type ReportFile,
} from "./portfolio-metrics.js";

const EX_OK = 0;
const EX_SOFTWARE = 70;
const EX_CONFIG = 78;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function parseOutDir(argv: readonly string[]): string {
  for (const arg of argv) {
    if (arg.startsWith("--out-dir=")) return arg.slice("--out-dir=".length);
  }
  return join(repoRoot, EVAL_REPORT_DIR);
}

/** 리포트 디렉터리가 아예 없을 수 있다. 없는 것은 오류가 아니라 "0건"이다. */
function readReportDir(dir: string): ReportFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: ReportFile[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    files.push({ name, raw: readFileSync(join(dir, name), "utf8") });
  }
  return files;
}

function main(argv: readonly string[]): number {
  const outDir = parseOutDir(argv);

  let loopRaw: string;
  try {
    loopRaw = readFileSync(join(repoRoot, LOOP_LOG_PATH), "utf8");
  } catch (error: unknown) {
    process.stderr.write(
      `[portfolio] ${LOOP_LOG_PATH}를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EX_SOFTWARE;
  }

  let metricsJson: string;
  let metricsTable: string;
  let anomalies: readonly string[];
  try {
    const metrics = buildLoopMetrics(parseLoopLog(loopRaw));
    metricsJson = `${JSON.stringify(metrics, null, 2)}\n`;
    metricsTable = renderLoopMetricsTable(metrics);
    anomalies = metrics.anomalies;
  } catch (error: unknown) {
    process.stderr.write(
      `[portfolio] 루프 로그가 깨졌다: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EX_SOFTWARE;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, LOOP_METRICS_JSON), metricsJson, "utf8");
  writeFileSync(
    join(outDir, LOOP_METRICS_MD),
    [
      "# 루프 계측 지표",
      "",
      `원천: \`${LOOP_LOG_PATH}\` · 생성: \`tools/portfolio-report.cli.ts\``,
      "",
      metricsTable,
      "",
      "## 계측 결함",
      "",
      anomalies.length === 0 ? "없음." : anomalies.map((line) => `- ${line}`).join("\n"),
      "",
    ].join("\n"),
    "utf8",
  );

  const series = collectEvalSeries(readReportDir(outDir));
  const missing: string[] = [];
  for (const kind of GRAPH_KINDS) {
    const one = series.get(kind);
    if (one === undefined) continue;
    writeFileSync(join(outDir, evalSvgFileName(kind)), renderEvalSvg(one, ABSENT_REASONS[kind]), "utf8");
    if (one.absent) missing.push(kind);
  }

  process.stderr.write(
    `[portfolio] 루프 지표: ${LOOP_METRICS_JSON} / ${LOOP_METRICS_MD} (계측 결함 ${String(anomalies.length)}건)\n`,
  );
  if (missing.length === 0) {
    process.stderr.write(`[portfolio] eval 그래프 ${String(GRAPH_KINDS.length)}종 전부 실측 데이터로 그렸다.\n`);
    return EX_OK;
  }
  for (const kind of missing) {
    process.stderr.write(
      `[portfolio] ⚠️ ${kind}: 리포트 0건 — ${ABSENT_REASONS[kind as keyof typeof ABSENT_REASONS]}\n`,
    );
  }
  process.stderr.write(
    "[portfolio] 그래프를 0으로 채우지 않는다. 잴 수 없으면 거절한다 (exit 78).\n",
  );
  return EX_CONFIG;
}

process.exit(main(process.argv.slice(2)));
