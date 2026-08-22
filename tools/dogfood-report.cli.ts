/**
 * 도그푸딩 주간 리포트 생성기 (T-024 Scope 3).
 *
 * 컴포지션 루트다 — 인자·파일·종료 코드를 다루는 유일한 지점이고 집계는 전부
 * `dogfood-report.ts`가 갖는다. `scripts/mcp-ping.cli.ts`와 같은 규약이다.
 *
 * 사용법:
 *   pnpm exec tsx tools/dogfood-report.cli.ts
 *   pnpm exec tsx tools/dogfood-report.cli.ts --week=2026-W34
 *   pnpm exec tsx tools/dogfood-report.cli.ts --log=<경로> --root=<경로>
 *
 * 출력: 리포트 JSON은 **stdout**, 진단·요약은 **stderr**.
 * 파일은 `<root>/eval/reports/dogfood-{week}.json`에 쓴다.
 *
 * 종료 코드
 *   0  리포트 생성
 *  78  입력 오설정 (로그 파일 없음 / 깨진 줄 / 잘못된 --week)
 *  70  이 스크립트 자신의 버그
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDogfoodReport,
  DOGFOOD_LOG_PATH,
  DOGFOOD_REPORT_DIR,
  dogfoodReportFileName,
  DogfoodLogError,
  DogfoodWeekError,
  isoWeekOf,
  parseDogfoodLog,
  summarizeDogfoodReport,
} from "./dogfood-report.js";

const EXIT = { OK: 0, SOFTWARE: 70, CONFIG: 78 } as const;

const HELP = `dogfood-report — ${DOGFOOD_LOG_PATH}를 ISO 주 단위로 집계한다 (T-024).

  --week=YYYY-Www   집계할 ISO 주 (기본: 오늘이 속한 주)
  --log=<경로>      이벤트 로그 (기본: <root>/${DOGFOOD_LOG_PATH})
  --root=<경로>     레포 루트 (기본: 이 파일 기준 상위)
  --help            이 도움말

리포트 JSON은 stdout으로, 요약은 stderr로 나간다.
파일은 <root>/${DOGFOOD_REPORT_DIR}/dogfood-{week}.json에 쓴다.`;

/** 오설정은 사용자가 고칠 것 — 스택을 뱉지 않고 한 줄로 알린다. */
class ConfigError extends Error {}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function resolve(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value);
}

function main(argv: readonly string[]): void {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    process.stderr.write(`${HELP}\n`);
    return;
  }

  const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = readFlag(argv, "root") ?? defaultRoot;
  const week = readFlag(argv, "week") ?? isoWeekOf(new Date());
  const logPath = resolve(root, readFlag(argv, "log") ?? DOGFOOD_LOG_PATH);

  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    // 없는 파일을 "0건"으로 읽지 않는다 — 지표가 0인 이유가 통째로 달라진다.
    throw new ConfigError(
      `이벤트 로그를 읽지 못했다: ${logPath}\n` +
        `프로토콜을 아직 기록하지 않았다면 빈 파일을 만들어라: touch ${DOGFOOD_LOG_PATH}`,
    );
  }

  const report = buildDogfoodReport(parseDogfoodLog(raw), { week, generatedAt: new Date() });
  const outPath = join(root, DOGFOOD_REPORT_DIR, dogfoodReportFileName(report.week));
  mkdirSync(dirname(outPath), { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(outPath, json, "utf8");

  process.stdout.write(json);
  process.stderr.write(`${summarizeDogfoodReport(report)}\n[dogfood] wrote ${outPath}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof DogfoodLogError ||
    error instanceof DogfoodWeekError ||
    error instanceof ConfigError
  ) {
    // 셋 다 호출자가 고칠 입력 오류다. 메시지가 어느 쪽인지 이미 말해 준다.
    process.stderr.write(`[dogfood] ${error.message}\n`);
    process.exitCode = EXIT.CONFIG;
  } else {
    process.stderr.write(
      `[dogfood] 내부 오류: ${error instanceof Error ? error.message : "알 수 없음"}\n`,
    );
    process.exitCode = EXIT.SOFTWARE;
  }
}
