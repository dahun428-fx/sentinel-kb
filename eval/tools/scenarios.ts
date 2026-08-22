/**
 * 시나리오 로더 + **카탈로그 대조 검증**. 출처: specs/05 "Eval 3: 시나리오 20개",
 * T-016 Scope(`{prompt, expectedTool, requiredArgs[]}`).
 *
 * ## 스펙의 세 필드에 두 개를 더 얹은 이유
 * T-016 Scope는 `{prompt, expectedTool, requiredArgs[]}`를 적었지만, **specs/05 본문의 예시가
 * 그 세 필드로는 표현되지 않는다**: `record_knowledge(type:divergence)`는 도구 이름만이 아니라
 * **인자 값**까지 정답에 포함한다. 그래서 `expectedArgs`(값까지 보는 인자)를 더했다.
 * `boundary`는 각 시나리오가 무슨 경계를 가르는지를 적는 자리다 — 없으면 리포트에서 오답을
 * 봐도 "왜 이 케이스가 있는가"를 아무도 모르고, 골든셋이 조용히 부패한다.
 * `id`는 리포트가 시나리오를 가리키는 안정된 이름이다(순번은 항목이 늘면 밀린다).
 *
 * ## `requiredArgs`는 도구 스키마의 `required`가 **아니다**
 * 스키마 필수 인자는 "안 주면 호출이 거부되는 인자"이고, 여기 `requiredArgs`는
 * "이 요청을 제대로 처리하려면 **채웠어야 하는** 인자"다. 예: `record_knowledge`의
 * `symptom`·`resolution`은 스키마상 `optional`이지만(type별로 갈리므로) incident를 기록하는
 * 시나리오에서 비우면 그 호출은 틀린 호출이다. 반대로 `suggest_resolution`의 `project`는
 * 프롬프트에 프로젝트 이름이 나와도 필수가 아니다.
 * **다만 도구에 존재하지 않는 인자를 요구할 수는 없다** — 그건 시나리오의 오타이고,
 * `validateScenarios`가 로드 시점에 죽인다.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { findTool, type ToolCatalog } from "./catalog.js";

/** specs/05 "시나리오 20개". */
export const EXPECTED_SCENARIO_COUNT = 20;

/** `eval/tools/` 기준 상대 위치. `import.meta.url`로 잡아 cwd에 의존하지 않는다. */
export const SCENARIOS_URL = new URL("./scenarios.json", import.meta.url);
/** 사람에게 보여 줄 레포 루트 기준 경로. */
export const SCENARIOS_PATH = "eval/tools/scenarios.json";

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export const Scenario = z
  .object({
    id: z.string().regex(/^TS-\d{2}$/, "id는 TS-01 형식이다"),
    prompt: z.string().min(1),
    /**
     * `null`은 **"아무 도구도 부르지 않는 것이 정답"**이다. 이 값이 없는 골든셋은
     * "무언가는 반드시 불러야 한다"만 재게 되고, 에이전트가 아무거나 부르는 실패를 못 잡는다.
     */
    expectedTool: z.string().min(1).nullable(),
    requiredArgs: z.array(z.string().min(1)),
    /** 값까지 봐야 하는 인자. 값은 문자열로 비교한다(`helped: "true"`). */
    expectedArgs: z.record(z.string(), z.string()).default({}),
    boundary: z.string().min(1),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export const ScenarioFile = z.object({
  scenarios: z.array(Scenario),
});

/**
 * 시나리오와 **실제 도구 계약**을 대조한다. 여기서 걸리는 것은 전부 골든셋의 결함이거나
 * 계약이 움직였다는 신호다 — 어느 쪽이든 그 상태로 잰 수치는 기준선이 될 수 없으므로 던진다.
 */
export function validateScenarios(
  scenarios: readonly Scenario[],
  catalog: ToolCatalog,
): void {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) problems.push(`${scenario.id}: id가 중복이다.`);
    seen.add(scenario.id);

    if (new Set(scenario.requiredArgs).size !== scenario.requiredArgs.length) {
      problems.push(`${scenario.id}: requiredArgs에 같은 이름이 두 번 있다.`);
    }

    for (const name of Object.keys(scenario.expectedArgs)) {
      if (!scenario.requiredArgs.includes(name)) {
        problems.push(
          `${scenario.id}: expectedArgs.${name}이 requiredArgs에 없다. ` +
            "값을 보는 인자는 '채웠는지'도 봐야 한다 — 안 그러면 비워 둔 호출이 값 검사를 건너뛴다.",
        );
      }
    }

    if (scenario.expectedTool === null) {
      if (scenario.requiredArgs.length > 0 || Object.keys(scenario.expectedArgs).length > 0) {
        problems.push(
          `${scenario.id}: expectedTool이 null인데 인자를 요구한다. 부르지 않을 도구의 인자는 없다.`,
        );
      }
      continue;
    }

    const tool = findTool(catalog, scenario.expectedTool);
    if (tool === undefined) {
      problems.push(
        `${scenario.id}: expectedTool "${scenario.expectedTool}"이 등록된 도구에 없다 ` +
          `(등록: ${catalog.tools.map((entry) => entry.name).join(", ")}).`,
      );
      continue;
    }

    const argNames = new Set(tool.args.map((arg) => arg.name));
    for (const name of scenario.requiredArgs) {
      if (!argNames.has(name)) {
        problems.push(
          `${scenario.id}: ${tool.name}에 "${name}" 인자가 없다 ` +
            `(있는 인자: ${[...argNames].join(", ")}). 시나리오의 오타이거나 계약이 바뀌었다.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ScenarioError(
      `${SCENARIOS_PATH}가 현재 도구 계약과 맞지 않는다:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
}

/**
 * 사람이 읽어야 할 단서. **던지지 않는다** — 시나리오 수가 19건이어도 잰 것은 잰 것이고,
 * "재지 못했다"와 구별되어야 한다(T-013 `goldenSetWarnings`와 같은 규약).
 */
export function scenarioWarnings(
  scenarios: readonly Scenario[],
  catalog: ToolCatalog,
  expectedCount: number = EXPECTED_SCENARIO_COUNT,
): string[] {
  const warnings: string[] = [];

  if (scenarios.length !== expectedCount) {
    warnings.push(
      `시나리오가 ${String(scenarios.length)}건이다. specs/05 Eval 3은 ${String(expectedCount)}개를 요구한다.`,
    );
  }

  const covered = new Set(scenarios.map((scenario) => scenario.expectedTool));
  const uncovered = catalog.tools
    .map((tool) => tool.name)
    .filter((name) => !covered.has(name));
  if (uncovered.length > 0) {
    warnings.push(
      `시나리오가 한 건도 없는 도구가 있다: ${uncovered.join(", ")}. ` +
        "그 도구의 description은 이 eval이 재지 않는다 — G6가 그 부분에 대해서는 공백이다.",
    );
  }

  if (!covered.has(null)) {
    warnings.push(
      "'아무 도구도 부르지 않는 것이 정답'인 시나리오가 없다. " +
        "전부 무언가를 불러야 하는 골든셋은 에이전트가 아무거나 부르는 실패를 잡지 못한다.",
    );
  }

  return warnings;
}

/** 파일에서 읽고 스키마 파싱 + 계약 대조까지 한 번에. 실패는 전부 `ScenarioError`로 나간다. */
export async function loadScenarios(
  catalog: ToolCatalog,
  url: URL = SCENARIOS_URL,
): Promise<Scenario[]> {
  let parsed: z.infer<typeof ScenarioFile>;
  try {
    parsed = ScenarioFile.parse(JSON.parse(await readFile(url, "utf8")));
  } catch (error) {
    throw new ScenarioError(
      `${SCENARIOS_PATH}를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateScenarios(parsed.scenarios, catalog);
  return parsed.scenarios;
}
