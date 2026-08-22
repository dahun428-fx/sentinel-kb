import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **`pnpm eval:generation`이 잴 수 없는 상태에서 무엇으로 끝나는지**를 프로세스 수준에서 본다.
 *
 * 요점은 하나다: **판정 불가를 0으로 끝내지 않는다.** 지금 이 레포에는 judge를 세울
 * API 키가 없고 시드된 core-api도 떠 있지 않다. 그 상태에서 exit 0으로 끝나면 CI가
 * "generation eval 통과"로 읽고, G4가 아무것도 검사하지 않은 채 통과 도장을 찍는다.
 *
 * 리포트를 쓰기 **전에** 죽는 경로만 고른다 — 테스트가 `eval/reports/`에 파일을 남기면 안 된다.
 * (그래서 `--allow-fixture-judge`도 여기서는 돌리지 않는다: 그 경로는 core-api를 실제로 부른다.)
 */
/** 임베딩 게이트를 통과시키는 최소 env. 이걸 갖춰야 그 **다음** 게이트가 관측된다. */
const EMBEDDER_ENV: NodeJS.ProcessEnv = {
  EMBEDDING_PROVIDER: "voyage",
  EMBEDDING_MODEL: "voyage-3",
  EMBEDDING_DIM: "1024",
  EMBEDDING_VERSION: "1",
};

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./run.cli.ts", import.meta.url));

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...argv], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      // 실행 환경의 자격증명이 테스트 결과를 바꾸지 못하게 **명시적으로 비운다**.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
      EVAL_JUDGE_MODEL: "",
      EMBEDDING_PROVIDER: "",
      EMBEDDING_MODEL: "",
      EMBEDDING_DIM: "",
      EMBEDDING_VERSION: "",
      API_KEYS: "",
      ...env,
    },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("pnpm eval:generation — 잴 수 없으면 거절한다", () => {
  /** 임베딩 설정이 아예 없는 상태. 오설정은 품질 회귀가 아니라 판정 불가다. */
  it("아무 설정도 없으면 exit 78이고, 0이 아니다", () => {
    const run = runCli([]);
    expect(run.status, "판정 불가가 통과(0)로 끝나고 있다").toBe(78);
    expect(run.stderr).toContain("EMBEDDING_CONFIG_INVALID");
  });

  /** fake 임베딩 위에서는 grounded 케이스가 전부 게이트에 걸린다 — 재는 시늉만 하게 된다. */
  it("EMBEDDING_PROVIDER=fake면 무엇도 재지 않고 78로 끝난다", () => {
    const run = runCli([], { ...EMBEDDER_ENV, EMBEDDING_PROVIDER: "fake" });
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("EVAL_CONFIG_INVALID");
    expect(run.stderr).toContain("fake");
  });

  it("judge를 세울 수 없으면 무엇이 없어서 못 재는지 말한다", () => {
    const run = runCli([], { ...EMBEDDER_ENV, API_KEYS: "key-alpha:sentinel-kb" });
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("JUDGE_UNAVAILABLE");
    expect(run.stderr).toContain("EVAL_JUDGE_MODEL");
  });

  it("알 수 없는 인자는 무시되지 않는다 (78)", () => {
    const run = runCli(["--expected-cases", "15"]);
    expect(run.status).toBe(78);
    expect(run.stderr).toContain("EVAL_CONFIG_INVALID");
  });
});
