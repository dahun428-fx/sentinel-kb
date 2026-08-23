/**
 * `README.md`의 루프 지표 표를 `eval/loop-log.jsonl`에서 재생성한다.
 *
 * T-028이 만든 가드(`portfolio-docs.spec.ts`)는 그 표가 로그에서 재계산한 값과
 * **한 글자도** 다르지 않을 것을 요구한다. 태스크가 하나 늘 때마다 표가 낡으므로
 * `pnpm verify`가 빨개진다 — 그때 손으로 고치면 두 번째 진실 원천이 생긴다.
 *
 * 그래서 **T-028이 만든 바로 그 함수**로 다시 그린다. 이 파일은 계산을 하지 않는다.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { buildLoopMetrics, parseLoopLog, renderLoopMetricsTable } from "./portfolio-metrics.js";

const BEGIN = "<!-- loop-metrics:begin -->";
const END = "<!-- loop-metrics:end -->";

const table = renderLoopMetricsTable(
  buildLoopMetrics(parseLoopLog(readFileSync("eval/loop-log.jsonl", "utf8"))),
);
const readme = readFileSync("README.md", "utf8");
const begin = readme.indexOf(BEGIN);
const end = readme.indexOf(END);

if (begin < 0 || end < 0) {
  console.error(`[sync-readme-metrics] README.md에 ${BEGIN} / ${END} 마커가 없다.`);
  process.exitCode = 78; // EX_CONFIG
} else {
  writeFileSync("README.md", `${readme.slice(0, begin + BEGIN.length)}\n${table}\n${readme.slice(end)}`);
  console.log("[sync-readme-metrics] README 루프 지표 표를 재생성했다.");
}
