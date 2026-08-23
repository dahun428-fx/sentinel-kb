/**
 * **프로세스 수준에서 종료 코드를 본다.** 판정이 맞아도 CLI가 종료 코드를 안 실으면 CI는
 * 아무것도 막지 못한다 — `eval/injection/run.cli.spec.ts`가 세운 것과 같은 규약이다.
 *
 * 지금 이 레포 상태에서 기대되는 결과는 **78(판정 불가)**이다. 이유가 셋이고 셋 다 실재한다:
 * `eval/baselines.json`에 `style` 절이 없고, judge 자격증명이 없고, 사람 글이 3편이 아니다.
 * **이 78을 0으로 바꾸려는 변경은 자격증명 없이 돌린 CI를 "AI 티 없음"으로 읽게 만든다** —
 * 판별 정확도는 낮을수록 좋은 지표라, 아무것도 재지 않은 실행이 가장 좋은 점수를 낸다.
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
    // 셸에 키가 있어도 결과가 흔들리지 않아야 한다 — 이 테스트가 재는 것은 거절 경로다.
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 프로세스 기동은 비싸다(테스트 1건당 tsx 부팅 한 번). 같은 실행을 세 번 다시 띄우면
 * 레포의 시간 민감한 테스트들과 CPU를 다투게 되므로, 인자 없는 실행은 **한 번만** 돌리고
 * 관측만 나눠 단언한다.
 */
const NO_ARGS = runCli();

describe("pnpm eval:style — 종료 코드", () => {
  it("잴 수 없으면 0이 아니라 78로 끝난다", () => {
    expect(NO_ARGS.status).toBe(78);
  });

  it("왜 못 쟀는지 stderr에 남긴다 — 조용히 통과하지 않는다", () => {
    expect(NO_ARGS.stderr).toMatch(/BASELINE_MISSING|JUDGE_UNAVAILABLE|DRAFT_MODEL_UNAVAILABLE/u);
  });

  it("판정도 리포트도 없이 통과 문구를 내지 않는다", () => {
    expect(NO_ARGS.stdout).not.toContain("기준선 통과");
  });

  it("알 수 없는 인자는 조용히 무시하지 않고 78로 거절한다", () => {
    const run = runCli(["--limit=3"]);

    expect(run.status).toBe(78);
    expect(run.stderr).toContain("인자를 받지 않는다");
  });
});
