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

  /**
   * **사유가 바뀌었다.** T-016 시점에는 "tool-calling 인터페이스가 없다"가 사유였고 그때는
   * 참이었다. T-039가 `createToolChoiceModel()`을 세우고 러너가 그것을 물면서 남은 사유는
   * **자격증명 부재** 하나다 — 키를 채우면 풀리는 종류의 실패다.
   */
  it("무엇이 없어서 못 재는지 말한다 — 이제는 자격증명 문제다", () => {
    try {
      resolveSelector({}, { allowOracle: false, scenarios: [] });
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
      expect((error as Error).message).toContain("createToolChoiceModel");
      expect((error as Error).message).toContain("packages/core/src/llm");
    }
  });

  it("구현이 없는 provider 이름을 주면 그 이름을 인용해 던진다", () => {
    expect(() =>
      resolveSelector({ [SELECTOR_ENV]: "openai" }, { allowOracle: true, scenarios: [] }),
    ).toThrow(/openai/);
  });

  /** 오라클 허가가 **명시된 provider를 갈아치우지 않는다** — 그러면 요청과 다른 것을 잰다. */
  it("EVAL_TOOL_SELECTOR=anthropic은 --allow-oracle-selector로도 오라클이 되지 않는다", () => {
    expect(() =>
      resolveSelector({ [SELECTOR_ENV]: "anthropic" }, { allowOracle: true, scenarios: [] }),
    ).toThrow(SelectorUnavailableError);
  });

  it("--allow-oracle-selector면 오라클을 세우되 trusted:false다", () => {
    const selector = resolveSelector({}, { allowOracle: true, scenarios: [] });
    expect(selector.provenance.trusted).toBe(false);
    expect(selector.provenance.provider).toBe("oracle");
  });
});
