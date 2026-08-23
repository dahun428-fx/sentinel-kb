/**
 * 실 모델 selector의 배선을 잠근다. **모델은 부르지 않는다** —
 * `createFakeToolChoiceModel()`이 `ToolChoiceModel` 계약을 그대로 만족하므로,
 * 여기서 재는 것은 "우리가 무엇을 실어 보내고 무엇을 돌려받아 어떻게 옮기는가"다.
 * 실제 호출은 eval 계층에서만 일어난다는 specs/05 결정론 원칙을 지킨다.
 *
 * 잠그는 것 넷:
 *  1. **빈 `toolUses`는 `{tool: null}`이다** — 에러도 오답도 아니다(T-039 F-2).
 *     이게 무너지면 `expectedTool: null` 시나리오가 전부 오답이 되고, 이 eval은
 *     "에이전트가 아무거나 부르는 실패"를 구조적으로 못 잡게 된다.
 *  2. **모델에게 실어 보내는 도구 목록이 실물 카탈로그다** — 스냅샷이 아니다(G6).
 *  3. **`trusted`는 provider 이름이 정한다** — 자격증명이 없으면 selector 자체가 안 선다.
 *  4. **78의 사유가 자격증명 부재다** — "인터페이스가 없다"가 아니다(A-1의 산출물).
 */
import { createFakeToolChoiceModel, LlmError, LLM_ERROR_CODES } from "@sentinel/core";
import { describe, expect, it } from "vitest";

import { loadToolCatalog } from "./catalog.js";
import { runToolsEval } from "./run.js";
import { loadScenarios } from "./scenarios.js";
import {
  ANTHROPIC_SELECTOR,
  createAnthropicSelector,
  resolveSelector,
  SelectorCallError,
  SelectorUnavailableError,
  toToolChoice,
} from "./selector.js";

const catalog = loadToolCatalog();
const scenarios = await loadScenarios(catalog);

/** 형태만 갖춘 가짜 자격증명. 네트워크를 타지 않는다 — 모델 **생성**만 확인한다. */
const FAKE_CREDENTIALS: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-not-a-real-key-for-tests",
  ANTHROPIC_MODEL: "test-model-id",
};

const NO_CREDENTIALS: NodeJS.ProcessEnv = {};

function select(prompt: string, model: Parameters<typeof createAnthropicSelector>[0]) {
  return createAnthropicSelector(model).select({ prompt, catalog, attempt: 1 });
}

describe("toToolChoice — 빈 배열은 정상이다 (T-039 F-2)", () => {
  it("아무 도구도 고르지 않으면 tool이 null이다", () => {
    expect(toToolChoice([])).toEqual({ tool: null, args: {} });
  });

  it("고른 도구의 이름과 인자를 그대로 옮긴다", () => {
    expect(toToolChoice([{ name: "get_record", input: { recordId: "abc" } }])).toEqual({
      tool: "get_record",
      args: { recordId: "abc" },
    });
  });

  it("input이 객체가 아니면 '인자를 안 채웠다'로 읽는다 — 던지지 않는다", () => {
    expect(toToolChoice([{ name: "get_record", input: "not-an-object" }]).args).toEqual({});
  });

  it("도구를 둘 이상 부르면 첫 번째가 실린다 — '아무것도 안 불렀다'로 접히지 않는다", () => {
    const choice = toToolChoice([
      { name: "search_knowledge", input: { query: "a" } },
      { name: "get_record", input: { recordId: "b" } },
    ]);
    expect(choice.tool).toBe("search_knowledge");
  });
});

describe("createAnthropicSelector — 모델에게 무엇을 묻는가", () => {
  it("빈 응답을 오답이 아니라 '도구 없음 선택'으로 옮긴다", async () => {
    const model = createFakeToolChoiceModel();
    const choice = await select("아무 도구도 필요 없는 잡담", model);
    expect(choice, "빈 toolUses가 에러나 가짜 도구로 접혔다").toEqual({ tool: null, args: {} });
  });

  it("도구 목록을 **실물 카탈로그에서** 실어 보낸다 (스냅샷 금지, G6)", async () => {
    const model = createFakeToolChoiceModel();
    await select("아무거나", model);

    const sent = model.calls[0]?.tools ?? [];
    expect(sent.map((tool) => tool.name)).toEqual(catalog.tools.map((tool) => tool.name));
    expect(sent.map((tool) => tool.description)).toEqual(
      catalog.tools.map((tool) => tool.description),
    );
  });

  it("인자 스키마가 함께 나간다 — 필수 인자를 모델이 알 수 있어야 채점이 성립한다", async () => {
    const model = createFakeToolChoiceModel();
    await select("아무거나", model);

    const search = model.calls[0]?.tools.find((tool) => tool.name === "search_knowledge");
    expect(search?.inputSchema["type"]).toBe("object");
    expect(search?.inputSchema["required"]).toContain("query");
  });

  it("시나리오의 정답·경계 설명을 프롬프트에 싣지 않는다 — 힌트를 재면 안 된다", async () => {
    const model = createFakeToolChoiceModel();
    const scenario = scenarios[0];
    if (scenario === undefined) throw new Error("시나리오가 비어 있다.");
    await select(scenario.prompt, model);

    const call = model.calls[0];
    expect(call?.messages.map((message) => message.content)).toEqual([scenario.prompt]);
    expect(call?.system, "시스템 프롬프트가 붙었다 — 우리가 쓴 문장을 재게 된다").toBeUndefined();
  });

  it("모델 호출 실패는 '오답'이 아니라 SelectorCallError다 (69로 나간다)", async () => {
    const broken = {
      model: "test-model-id",
      selectTool: () =>
        Promise.reject(new LlmError(LLM_ERROR_CODES.REQUEST_FAILED, "status=429")),
    };
    await expect(select("아무거나", broken)).rejects.toBeInstanceOf(SelectorCallError);
  });

  it("provenance가 신뢰 가능이고 모델 식별자를 그대로 싣는다", () => {
    const model = createFakeToolChoiceModel({ model: "test-model-id" });
    expect(createAnthropicSelector(model).provenance).toEqual({
      provider: ANTHROPIC_SELECTOR,
      model: "test-model-id",
      trusted: true,
    });
  });
});

describe("resolveSelector — 78의 사유", () => {
  it("자격증명이 없으면 selector를 세우지 않는다", () => {
    expect(() => resolveSelector(NO_CREDENTIALS, { allowOracle: false, scenarios })).toThrow(
      SelectorUnavailableError,
    );
  });

  it("거절 사유가 '자격증명 부재'다 — '인터페이스 부재'가 아니다", () => {
    let message = "";
    try {
      resolveSelector(NO_CREDENTIALS, { allowOracle: false, scenarios });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message, "러너가 무는 인터페이스를 말하지 않는다").toContain("createToolChoiceModel");
  });

  it("자격증명이 있으면 실 모델 selector가 선다 — 배선이 실재한다는 증거", () => {
    const selector = resolveSelector(FAKE_CREDENTIALS, { allowOracle: false, scenarios });
    expect(selector.provenance.provider).toBe(ANTHROPIC_SELECTOR);
    expect(selector.provenance.model).toBe(FAKE_CREDENTIALS["ANTHROPIC_MODEL"]);
    expect(selector.provenance.trusted).toBe(true);
  });

  it("오라클은 자격증명이 있어도 trusted:false다", () => {
    const selector = resolveSelector(FAKE_CREDENTIALS, { allowOracle: true, scenarios });
    expect(selector.provenance.trusted, "오라클 만점이 판정 대상이 됐다").toBe(false);
  });

  it("모르는 selector 이름은 조용히 다른 것으로 내려앉지 않는다", () => {
    expect(() =>
      resolveSelector(
        { ...FAKE_CREDENTIALS, EVAL_TOOL_SELECTOR: "some-provider" },
        { allowOracle: false, scenarios },
      ),
    ).toThrow(/some-provider/);
  });
});

describe("빈 응답이 채점기까지 살아서 도착한다", () => {
  /**
   * **뮤테이션 킬러다.** 빈 `toolUses`를 에러나 임의의 도구로 접으면
   * "아무 도구도 부르지 않는 것이 정답"인 시나리오 묶음이 통째로 0점이 된다.
   * 개수를 리터럴로 적지 않는다 — 골든셋에서 세어 온다.
   */
  it("expectedTool:null 묶음이 만점이고, 나머지는 아니다", async () => {
    const noneCount = scenarios.filter((scenario) => scenario.expectedTool === null).length;
    expect(noneCount, "'도구 없음이 정답'인 시나리오가 골든셋에 없다").toBeGreaterThan(0);

    const report = await runToolsEval({
      scenarios,
      catalog,
      selector: createAnthropicSelector(createFakeToolChoiceModel()),
      repeats: 1,
      baselines: { selectionAccuracy: 0.85 },
      now: new Date("2026-08-23T12:00:00.000Z"),
      expectedScenarioCount: scenarios.length,
    });

    const none = report.byExpectedTool.find((entry) => entry.expectedTool === null);
    expect(none?.scenarioCount).toBe(noneCount);
    expect(none?.selectionAccuracy, "빈 응답이 오답으로 접혔다").toBe(1);
    expect(
      report.metrics.selectionAccuracy,
      "아무것도 안 부르는 모델이 만점을 받았다",
    ).toBeLessThan(1);
  });
});
