import { describe, expect, it } from "vitest";

import { DEFAULT_REPEATS, EvalArgsError, MAX_REPEATS, parseRunArgs } from "./args.js";
import { EXPECTED_SCENARIO_COUNT } from "./scenarios.js";
import { resolveSelector, SELECTOR_ENV, SelectorUnavailableError } from "./selector.js";

describe("parseRunArgs", () => {
  it("기본값은 20 시나리오 × 3회다 (T-016 Scope)", () => {
    expect(parseRunArgs([])).toEqual({
      repeats: DEFAULT_REPEATS,
      expectedScenarioCount: EXPECTED_SCENARIO_COUNT,
      allowOracleSelector: false,
    });
  });

  it("--repeats=5를 읽는다", () => {
    expect(parseRunArgs(["--repeats=5"]).repeats).toBe(5);
  });

  it("등호 없는 인자를 조용히 무시하지 않는다 — 3회로 잰 리포트를 5회로 착각하게 된다", () => {
    expect(() => parseRunArgs(["--repeats", "5"])).toThrow(EvalArgsError);
  });

  it("반복 상한을 넘으면 던진다", () => {
    expect(() => parseRunArgs([`--repeats=${String(MAX_REPEATS + 1)}`])).toThrow(EvalArgsError);
  });

  it("0회·음수는 던진다", () => {
    expect(() => parseRunArgs(["--repeats=0"])).toThrow(EvalArgsError);
  });

  it("알 수 없는 인자는 사용법과 함께 던진다", () => {
    expect(() => parseRunArgs(["--allow-fake-embeddings"])).toThrow(/사용법/);
  });
});

describe("resolveSelector — 잴 수 없으면 세우지 않는다", () => {
  it("기본값은 던진다. 조용히 fake로 내려앉지 않는다", () => {
    expect(() => resolveSelector({}, { allowOracle: false, scenarios: [] })).toThrow(
      SelectorUnavailableError,
    );
  });

  it("무엇이 없어서 못 재는지 말한다 — 자격증명만의 문제가 아니다", () => {
    try {
      resolveSelector({}, { allowOracle: false, scenarios: [] });
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      expect((error as Error).message).toContain("tool-calling");
      expect((error as Error).message).toContain("packages/core/src/llm");
    }
  });

  it("구현이 없는 provider 이름을 주면 그 이름을 인용해 던진다", () => {
    expect(() =>
      resolveSelector({ [SELECTOR_ENV]: "anthropic" }, { allowOracle: true, scenarios: [] }),
    ).toThrow(/anthropic/);
  });

  it("--allow-oracle-selector면 오라클을 세우되 trusted:false다", () => {
    const selector = resolveSelector({}, { allowOracle: true, scenarios: [] });
    expect(selector.provenance.trusted).toBe(false);
    expect(selector.provenance.provider).toBe("oracle");
  });
});
