import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **`pnpm eval:tools`가 잴 수 없는 상태에서 무엇으로 끝나는지**를 프로세스 수준에서 본다.
 *
 * 요점이 둘이다.
 *
 * 1. **판정 불가를 0으로 끝내지 않는다.** exit 0으로 끝나면 CI가 "tool-selection eval 통과"로
 *    읽고, G6가 요구하는 재실행이 실제로는 아무것도 검사하지 않는 채로 통과 도장을 찍는다.
 * 2. **78의 사유가 사실이어야 한다.** T-016 시점의 사유는 "레포에 tool-calling 인터페이스가
 *    없다"였고 그때는 참이었다. T-039가 `createToolChoiceModel()`을 세우고 이 러너가 그것을
 *    물면서 그 문장은 거짓이 됐다 — 지금 남은 사유는 **자격증명 부재** 하나다.
 *    거절 사유가 사실과 어긋나면 읽는 사람이 엉뚱한 것을 고치러 간다.
 *
 * **`ANTHROPIC_API_KEY`를 비워서 돌린다.** 실행하는 사람의 셸에 키가 있으면 이 테스트가
 * 실제 모델을 부르게 되고, 그 순간 unit 테스트가 네트워크·과금에 결합된다
 * (`eval/style/run.cli.spec.ts`·`eval/injection/run.cli.spec.ts`와 같은 격리).
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

function runCli(argv: readonly string[], overrides: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, EVAL_TOOL_SELECTOR: "", ANTHROPIC_API_KEY: "", ...overrides },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("pnpm eval:tools — 잴 수 없으면 거절한다", () => {
  it("자격증명이 없으면 exit 78이고, 0이 아니다", () => {
    const run = runCli([]);
    expect(run.status, "판정 불가가 통과(0)로 끝나고 있다").toBe(78);
    expect(run.stderr).toContain("SELECTOR_UNAVAILABLE");
  });

  /**
   * **이 태스크(A-1)의 산출물이 이 단언이다.** 배선 전에는 78의 사유가 "레포에 tool-calling
   * 가능한 모델 클라이언트가 없다"였고, 그건 키를 넣어도 풀리지 않는 사유였다.
   * 배선 뒤에는 `.env`에 키를 채우면 풀린다 — 사유가 그 사실을 말해야 한다.
   */
  it("78의 사유가 '인터페이스 부재'가 아니라 '자격증명 부재'다", () => {
    const run = runCli([]);
    expect(run.stderr, "무엇을 채우면 되는지 말하지 않는다").toContain("ANTHROPIC_API_KEY");
    expect(
      run.stderr,
      "러너가 어느 인터페이스를 무는지 말하지 않는다",
    ).toContain("createToolChoiceModel");
    expect(run.stderr).toContain("packages/core/src/llm");
  });

  it("구현이 없는 selector 이름을 주면 조용히 다른 것으로 내려앉지 않는다 (78)", () => {
    const run = runCli([], { EVAL_TOOL_SELECTOR: "some-provider" });
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("some-provider");
  });

  /** 오라클은 env 하나로 켜지지 않는다 — 정의상 1.0을 내는 경로이기 때문이다. */
  it("EVAL_TOOL_SELECTOR=oracle만으로는 오라클이 켜지지 않는다 (78)", () => {
    const run = runCli([], { EVAL_TOOL_SELECTOR: "oracle" });
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("--allow-oracle-selector");
  });

  it("알 수 없는 인자는 무시되지 않는다 (78)", () => {
    const run = runCli(["--repeats", "5"]);
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("EVAL_CONFIG_INVALID");
  });
});
