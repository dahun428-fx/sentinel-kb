/**
 * **프로세스 수준에서 종료 코드를 본다.** 판정이 맞아도 CLI가 종료 코드를 안 실으면 CI는
 * 아무것도 막지 못한다 — `check-baseline.cli.spec.ts`가 세운 것과 같은 규약이다.
 *
 * 지금 이 레포 상태에서 기대되는 결과는 **78(판정 불가)**이다. 방어선 3(프롬프트 내성)을
 * 잴 실 ChatModel provider가 없기 때문이다. **이 78을 0으로 바꾸려는 변경은 자격증명 없이
 * 돌린 CI를 "10/10 방어"로 읽게 만든다** — 그게 이 테스트가 막는 것이다.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./run.cli.ts", import.meta.url));

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[] = []): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // 자격증명이 셸에 있어도 결과가 흔들리지 않아야 한다 — 방어선 3은 provider 자체가 없다.
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("pnpm eval:injection — 종료 코드", () => {
  it("방어선 3을 못 재면 0이 아니라 78로 끝난다", () => {
    const run = runCli();

    expect(run.status).toBe(78);
  });

  it("세 방어선을 갈라서 출력한다 — 하나의 '방어율'로 뭉뚱그리지 않는다", () => {
    const { stdout } = runCli();

    expect(stdout).toContain("1 탐지");
    expect(stdout).toContain("2 제외");
    expect(stdout).toContain("3 프롬프트 내성");
    expect(stdout).toContain("판정 불가");
  });

  it("리포트 경로를 알려준다 (specs/05: eval/reports/YYYY-MM-DD-injection.json)", () => {
    expect(runCli().stdout).toMatch(/eval\/reports\/\d{4}-\d{2}-\d{2}-injection\.json/u);
  });

  it("알 수 없는 인자는 조용히 무시하지 않고 78로 거절한다", () => {
    const run = runCli(["--limit=5"]);

    expect(run.status).toBe(78);
    expect(run.stderr).toContain("인자를 받지 않는다");
  });
});
