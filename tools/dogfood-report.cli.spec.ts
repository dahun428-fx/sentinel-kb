import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOGFOOD_LOG_PATH, type DogfoodReport } from "./dogfood-report.js";

/**
 * **T-024 Acceptance 3을 프로세스 수준에서 판정한다.**
 *
 * "집계된다"는 순수 함수로 증명되지만 "리포트 JSON을 출력한다"는 아니다 —
 * 집계가 맞아도 CLI가 파일을 안 쓰거나 stdout을 안 채우면 아무것도 남지 않는다.
 * 그래서 실제 프로세스를 띄워 stdout·파일·종료 코드를 함께 본다.
 *
 * 양방향으로 건다: 정상 입력에서 0이 나오는 것만 보면 "항상 0을 내는 CLI"를 통과시키고,
 * 깨진 입력에서 78이 나오는 것만 보면 "항상 78을 내는 CLI"를 통과시킨다.
 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./dogfood-report.cli.ts", import.meta.url));

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "sentinel-dogfood-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** 임시 루트를 하나 만들고 로그를 심는다. 레포의 실제 로그·리포트를 건드리지 않는다. */
function makeRoot(name: string, lines: readonly string[]): string {
  const root = join(workDir, name);
  const logPath = join(root, DOGFOOD_LOG_PATH);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  return root;
}

const GOOD = [
  '{"ts":"2026-08-17T09:00:00Z","event":"search","results":0,"taskId":"T-024"}',
  '{"ts":"2026-08-18T09:00:00Z","event":"search","results":4,"taskId":"T-024"}',
  '{"ts":"2026-08-18T12:00:00Z","event":"record","recordId":"rec-1","type":"divergence"}',
  '{"ts":"2026-08-19T12:00:00Z","event":"hit","recordId":"rec-1"}',
];

describe("dogfood-report CLI", () => {
  it("주간 리포트 JSON을 stdout과 파일로 함께 낸다 (exit 0)", () => {
    const root = makeRoot("ok", GOOD);
    const result = run([`--root=${root}`, "--week=2026-W34"]);

    expect(result.status).toBe(0);

    const fromStdout = JSON.parse(result.stdout) as DogfoodReport;
    expect(fromStdout.week).toBe("2026-W34");
    expect(fromStdout.records.total).toBe(1);
    expect(fromStdout.searches).toEqual({
      total: 2,
      withResults: 1,
      zeroResult: 1,
      resultRate: 0.5,
    });
    expect(fromStdout.hits.total).toBe(1);

    // 파일명이 T-024 스펙의 `eval/reports/dogfood-{week}.json`이다.
    const written = readFileSync(join(root, "eval/reports/dogfood-2026-W34.json"), "utf8");
    expect(JSON.parse(written)).toEqual(fromStdout);
  });

  it("stdout은 JSON만 담는다 — 요약이 섞이면 파이프가 깨진다", () => {
    const root = makeRoot("clean", GOOD);
    const result = run([`--root=${root}`, "--week=2026-W34"]);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain("[dogfood]");
    expect(result.stderr).toContain("[dogfood]");
    expect(result.stderr).toContain("4주 누적");
  });

  it("--week이 없으면 오늘이 속한 주를 집계한다", () => {
    const root = makeRoot("default-week", GOOD);
    const result = run([`--root=${root}`]);
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as DogfoodReport).week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("깨진 줄은 줄 번호와 함께 exit 78이다 — 조용히 작아지지 않는다", () => {
    const root = makeRoot("broken", [GOOD[0] ?? "", "{ 이건 JSON이 아니다", GOOD[1] ?? ""]);
    const result = run([`--root=${root}`, "--week=2026-W34"]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(":2 —");
    expect(result.stdout).toBe("");
  });

  it("로그 파일이 없으면 0건이 아니라 exit 78이다", () => {
    const result = run([`--root=${join(workDir, "nowhere")}`, "--week=2026-W34"]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(DOGFOOD_LOG_PATH);
    expect(result.stdout).toBe("");
  });

  it("잘못된 --week은 exit 78이다 (없는 주를 옆 주로 바꾸지 않는다)", () => {
    const root = makeRoot("badweek", GOOD);
    // 2025년은 52주뿐이다. 조용히 2026-W01로 넘어가면 이름과 내용이 어긋난 리포트가 남는다.
    const result = run([`--root=${root}`, "--week=2025-W53"]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("2025-W53");
    expect(result.stdout).toBe("");
  });

  it("--help는 리포트를 쓰지 않는다", () => {
    const root = makeRoot("help", GOOD);
    const result = run([`--root=${root}`, "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--week");
  });
});
