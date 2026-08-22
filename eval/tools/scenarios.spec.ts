/**
 * 골든셋 자체를 검사한다. **여기서 잠그는 것은 점수가 아니라 시나리오의 구성**이다 —
 * 20건이 있어도 전부 "무언가를 불러야 한다"면 이 eval은 에이전트가 아무거나 부르는 실패를
 * 잡지 못하고, 경계 케이스가 없으면 description이 존재하는 이유를 아무것도 재지 않는다.
 */
import { describe, expect, it } from "vitest";

import { loadToolCatalog } from "./catalog.js";
import {
  EXPECTED_SCENARIO_COUNT,
  loadScenarios,
  scenarioWarnings,
  ScenarioError,
  validateScenarios,
  type Scenario,
} from "./scenarios.js";

const catalog = loadToolCatalog();
const scenarios = await loadScenarios(catalog);

function byId(id: string): Scenario {
  const found = scenarios.find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`${id}가 없다`);
  return found;
}

describe("scenarios.json — 구성", () => {
  it("specs/05가 요구하는 20건이다", () => {
    expect(scenarios).toHaveLength(EXPECTED_SCENARIO_COUNT);
  });

  it("id가 유일하다", () => {
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
  });

  it("도구 5종이 모두 최소 한 번 정답으로 나온다 — 안 나오는 도구는 G6의 공백이다", () => {
    const covered = new Set(scenarios.map((scenario) => scenario.expectedTool));
    for (const tool of catalog.tools) {
      expect(covered.has(tool.name), `${tool.name}을 정답으로 하는 시나리오가 없다`).toBe(true);
    }
  });

  /** **"전부 무언가를 불러야 한다"면 아무거나 부르는 실패를 못 잡는다.** */
  it("'아무 도구도 부르지 않는 것이 정답'인 시나리오가 여러 건 있다", () => {
    const none = scenarios.filter((scenario) => scenario.expectedTool === null);
    expect(none.length).toBeGreaterThanOrEqual(2);
    for (const scenario of none) {
      expect(scenario.requiredArgs).toEqual([]);
    }
  });

  it("모든 시나리오가 무슨 경계를 가르는지 적어 둔다", () => {
    for (const scenario of scenarios) {
      expect(scenario.boundary.length, `${scenario.id}에 boundary가 없다`).toBeGreaterThan(0);
    }
  });
});

describe("scenarios.json — 도구 간 경계", () => {
  it("search_knowledge와 suggest_resolution의 경계를 양방향으로 시험한다", () => {
    expect(byId("TS-05").expectedTool).toBe("search_knowledge"); // 목록만 원한다
    expect(byId("TS-06").expectedTool).toBe("suggest_resolution"); // 답을 원한다
  });

  it("search_knowledge와 get_record의 경계를 양방향으로 시험한다", () => {
    expect(byId("TS-07").expectedTool).toBe("get_record"); // recordId를 이미 안다
    expect(byId("TS-08").expectedTool).toBe("search_knowledge"); // recordId를 모른다
  });

  it("record_knowledge의 type을 양방향으로 판별한다 (incident vs divergence)", () => {
    expect(byId("TS-15").expectedArgs["type"]).toBe("incident");
    expect(byId("TS-16").expectedArgs["type"]).toBe("divergence");
  });

  /** specs/05 Eval 3이 직접 든 예시 셋. 스펙에 적힌 케이스가 골든셋에 있어야 한다. */
  it("specs/05 Eval 3의 예시 세 건이 그대로 들어 있다", () => {
    expect(byId("TS-01").expectedTool).toBe("suggest_resolution");
    expect(byId("TS-02")).toMatchObject({
      expectedTool: "record_knowledge",
      expectedArgs: { type: "divergence" },
    });
    expect(byId("TS-03").expectedTool).toBe("get_record");
  });

  /**
   * `give_feedback`의 `query`는 HTTP 계약상 필수인데 `specs/07:35`의 인자 목록에는 없다
   * (T-015 F-2). 시나리오가 이 인자를 채점하지 않으면 그 누락이 계속 안 보인다.
   */
  it("give_feedback 시나리오가 query를 필수 인자로 채점한다 (specs/07:35 누락 드러내기)", () => {
    expect(byId("TS-10").requiredArgs).toContain("query");
    expect(byId("TS-11").requiredArgs).toContain("query");
  });

  it("선택 인자를 언급했다고 필수로 세지 않는다 (suggest_resolution.project)", () => {
    expect(byId("TS-18").requiredArgs).toEqual(["errorText"]);
  });
});

describe("validateScenarios — 계약 대조", () => {
  const base: Scenario = {
    id: "TS-01",
    prompt: "프롬프트",
    expectedTool: "search_knowledge",
    requiredArgs: ["query"],
    expectedArgs: {},
    boundary: "테스트용",
  };

  it("커밋된 시나리오는 현재 계약과 맞는다", () => {
    expect(() => {
      validateScenarios(scenarios, catalog);
    }).not.toThrow();
  });

  it("등록되지 않은 도구를 기대하면 던진다", () => {
    expect(() => {
      validateScenarios([{ ...base, expectedTool: "delete_record" }], catalog);
    }).toThrow(ScenarioError);
  });

  it("도구에 없는 인자를 요구하면 던진다 — 계약이 움직였거나 시나리오 오타다", () => {
    expect(() => {
      validateScenarios([{ ...base, requiredArgs: ["queyr"] }], catalog);
    }).toThrow(/queyr/);
  });

  it("expectedArgs가 requiredArgs 밖이면 던진다 — 비워 둔 호출이 값 검사를 건너뛴다", () => {
    expect(() => {
      validateScenarios([{ ...base, expectedArgs: { type: "divergence" } }], catalog);
    }).toThrow(ScenarioError);
  });

  it("expectedTool이 null인데 인자를 요구하면 던진다", () => {
    expect(() => {
      validateScenarios([{ ...base, expectedTool: null }], catalog);
    }).toThrow(ScenarioError);
  });

  it("id가 중복이면 던진다", () => {
    expect(() => {
      validateScenarios([base, base], catalog);
    }).toThrow(/중복/);
  });
});

describe("scenarioWarnings — 던지지 않고 알린다", () => {
  it("건수가 기대와 다르면 경고한다", () => {
    expect(scenarioWarnings(scenarios.slice(0, 5), catalog).join("\n")).toContain("5건");
  });

  it("도구 없음 케이스가 하나도 없으면 경고한다", () => {
    const onlyTools = scenarios.filter((scenario) => scenario.expectedTool !== null);
    expect(scenarioWarnings(onlyTools, catalog).join("\n")).toContain("아무 도구도 부르지 않는");
  });

  it("커밋된 골든셋은 건수·커버리지 경고가 없다", () => {
    expect(scenarioWarnings(scenarios, catalog)).toEqual([]);
  });
});
