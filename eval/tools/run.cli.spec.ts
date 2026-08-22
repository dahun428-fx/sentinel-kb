import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **`pnpm eval:tools`가 잴 수 없는 상태에서 무엇으로 끝나는지**를 프로세스 수준에서 본다.
 *
 * 이 테스트의 요점은 하나다: **판정 불가를 0으로 끝내지 않는다.** 지금 이 레포에는
 * tool-calling 가능한 모델 클라이언트가 없어서(`selector.ts`) 이 CLI는 아무것도 재지 못하는데,
 * 그 상태에서 exit 0으로 끝나면 CI가 "tool-selection eval 통과"로 읽는다 —
 * G6가 요구하는 재실행이 실제로는 아무것도 검사하지 않는 채로 통과 도장을 찍게 된다.
 *
 * 리포트를 쓰기 **전에** 죽는 경로만 고른다 — 테스트가 `eval/reports/`에 파일을 남기면 안 된다.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./run.cli.ts", import.meta.url));

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(argv: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, EVAL_TOOL_SELECTOR: "" },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("pnpm eval:tools — 잴 수 없으면 거절한다", () => {
  it("selector가 없으면 exit 78이고, 0이 아니다", () => {
    const run = runCli([]);
    expect(run.status, "판정 불가가 통과(0)로 끝나고 있다").toBe(78);
    expect(run.stderr).toContain("SELECTOR_UNAVAILABLE");
  });

  it("무엇이 없어서 못 재는지 사람이 읽을 수 있게 말한다", () => {
    const run = runCli([]);
    // 자격증명만의 문제가 아니라는 것이 이 메시지의 핵심이다.
    expect(run.stderr).toContain("tool-calling");
    expect(run.stderr).toContain("packages/core/src/llm");
  });

  it("구현이 없는 selector 이름을 주면 조용히 다른 것으로 내려앉지 않는다 (78)", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", CLI], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, EVAL_TOOL_SELECTOR: "some-provider" },
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("some-provider");
  });

  it("알 수 없는 인자는 무시되지 않는다 (78)", () => {
    const run = runCli(["--repeats", "5"]);
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("EVAL_CONFIG_INVALID");
  });
});
