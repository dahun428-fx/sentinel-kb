import { describe, expect, it } from "vitest";

import {
  DEFAULT_CORE_API_PORT,
  DEFAULT_EVAL_PROJECT,
  EvalArgsError,
  assertMeasurableEmbeddings,
  defaultBaseUrl,
  parseRunArgs,
  resolveEvalApiKey,
} from "./args.js";
import { EXPECTED_CASE_COUNT } from "./cases.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("parseRunArgs", () => {
  it("인자가 없으면 기본값이다", () => {
    expect(parseRunArgs([], EMPTY_ENV)).toEqual({
      project: DEFAULT_EVAL_PROJECT,
      baseUrl: `http://localhost:${String(DEFAULT_CORE_API_PORT)}`,
      expectedCaseCount: EXPECTED_CASE_COUNT,
      allowFixtureJudge: false,
    });
  });

  /** 오타난 인자를 무시하면 사용자는 다른 설정으로 잰 리포트를 커밋한다. */
  it("알 수 없는 인자는 던진다 — 조용히 무시하지 않는다", () => {
    expect(() => parseRunArgs(["--expected-cases", "15"], EMPTY_ENV)).toThrow(EvalArgsError);
    expect(() => parseRunArgs(["--allow-fixture"], EMPTY_ENV)).toThrow(EvalArgsError);
  });

  it("--allow-fixture-judge를 읽는다", () => {
    expect(parseRunArgs(["--allow-fixture-judge"], EMPTY_ENV).allowFixtureJudge).toBe(true);
  });

  it("--base-url·--project·--expected-cases를 읽는다", () => {
    const args = parseRunArgs(
      ["--base-url=http://api:3001", "--project=other", "--expected-cases=20"],
      EMPTY_ENV,
    );
    expect(args).toMatchObject({
      baseUrl: "http://api:3001",
      project: "other",
      expectedCaseCount: 20,
    });
  });

  it("빈 값과 0 이하는 던진다", () => {
    expect(() => parseRunArgs(["--project="], EMPTY_ENV)).toThrow(EvalArgsError);
    expect(() => parseRunArgs(["--base-url="], EMPTY_ENV)).toThrow(EvalArgsError);
    expect(() => parseRunArgs(["--expected-cases=0"], EMPTY_ENV)).toThrow(EvalArgsError);
  });
});

describe("defaultBaseUrl", () => {
  /** retrieval eval과 **같은 규칙**이어야 두 리포트를 같은 서버 기준으로 대조할 수 있다. */
  it("EVAL_CORE_API_URL이 CORE_API_PORT를 이긴다", () => {
    expect(defaultBaseUrl({ EVAL_CORE_API_URL: "http://x:9", CORE_API_PORT: "3002" })).toBe(
      "http://x:9",
    );
    expect(defaultBaseUrl({ CORE_API_PORT: "3002" })).toBe("http://localhost:3002");
  });
});

describe("assertMeasurableEmbeddings", () => {
  /** fake 위에서는 grounded 케이스가 전부 게이트에 걸려 지표가 허수가 된다(시드 INC-18). */
  it("fake 임베딩이면 던진다 — 우회 플래그가 없다", () => {
    expect(() => assertMeasurableEmbeddings("fake")).toThrow(EvalArgsError);
    expect(() => assertMeasurableEmbeddings("fake")).toThrow(/found:false/);
  });

  it("실제 provider면 통과한다", () => {
    expect(() => assertMeasurableEmbeddings("voyage")).not.toThrow();
  });
});

describe("resolveEvalApiKey", () => {
  it("project로 해석되는 키를 고른다", () => {
    expect(resolveEvalApiKey(new Map([["k1", "other"], ["k2", "sentinel-kb"]]), "sentinel-kb")).toBe(
      "k2",
    );
  });

  it("없으면 던진다 — 키를 만들어내지 않는다", () => {
    expect(() => resolveEvalApiKey(new Map(), "sentinel-kb")).toThrow(EvalArgsError);
  });
});
