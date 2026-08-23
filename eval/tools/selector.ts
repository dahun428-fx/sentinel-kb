/**
 * "도구 목록을 주고 모델이 무엇을 고르는지 본다"의 경계면. specs/05 Eval 3:
 * > 도구 목록만 주고 Claude에게 제시 → **올바른 도구 + 필수 인자** 선택률 측정, 목표 0.9
 *
 * ---
 * ## 실 selector는 `@sentinel/core`의 `createToolChoiceModel()`이다 (T-039 D-7, F-2)
 *
 * T-016이 이 파일을 만들 때는 도구를 실어 보낼 인터페이스 자체가 없었다 — `ChatRequest`가
 * `{system, messages, maxTokens}`뿐이었고, 그래서 **키를 넣어도 잴 수 없었다.**
 * T-039가 `ToolChoiceModel { selectTool(req) }`을 `packages/core/src/llm/`에 세워 그 고리를
 * 이었고, 이 파일이 그것을 문다. **CLAUDE.md의 "LLM 호출은 `packages/core/src/llm/` 경유만
 * 허용"을 지킨다 — 여기서 SDK를 직접 부르지 않는다.**
 *
 * 그래서 지금 78의 사유는 "인터페이스가 없다"가 아니라 **"자격증명이 없다"**이다.
 * 그 구분이 중요한 이유: 전자는 사람이 코드를 써야 풀리고, 후자는 `.env`에 키를 넣으면 풀린다.
 * 둘을 같은 문장으로 거절하면 읽는 사람이 무엇을 해야 하는지 알 수 없다.
 *
 * ## ⚠️ 빈 `toolUses`는 정상이다 — 에러도 오답도 아니다 (T-039 F-2)
 * `selectTool()`은 모델이 아무 도구도 고르지 않으면 **빈 배열**을 돌려준다. 그것을 에러로
 * 접으면 `expectedTool: null`인 시나리오("아무 도구도 부르지 않는 것이 정답")가 전부 오답이
 * 되고, 이 eval은 **에이전트가 아무거나 부르는 실패를 영원히 못 잡는다.**
 * 아래 `toToolChoice`가 빈 배열을 `{tool: null}`로 옮기는 유일한 지점이다.
 *
 * ## `oracle`·`scripted`는 여전히 `trusted:false`다
 * 파이프라인이 도는지 보는 용도이지 도구 선택률을 재는 물건이 아니다. 오라클은 **정의상
 * 100%를 낸다** — 그 리포트가 기준선을 통과했다고 읽히는 순간 이 eval은 거짓말이 된다.
 * `trusted`를 손으로 적지 않고 `isTrustedSelector`가 provider 이름에서 정한다.
 */
import { createToolChoiceModel, type ToolChoiceModel, type ToolUse } from "@sentinel/core";

import type { ToolCatalog } from "./catalog.js";
import type { SelectorProvenance } from "./report.js";
import type { Scenario } from "./scenarios.js";

/**
 * 모델이 내놓은 선택 1회.
 * `tool: null`은 **아무 도구도 부르지 않았다**는 뜻이다 — "빈 이름의 도구"가 아니다.
 */
export interface ToolChoice {
  readonly tool: string | null;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SelectInput {
  /** 사용자 발화. 시나리오의 정답·경계 설명은 **넘기지 않는다**(그러면 힌트를 재게 된다). */
  readonly prompt: string;
  /** 실물 도구 목록. selector는 이걸 자기 방식(native tool-use 등)으로 모델에 싣는다. */
  readonly catalog: ToolCatalog;
  /** 반복 회차(1부터). 캐시를 우회하거나 로그를 구분해야 하는 구현이 쓴다. */
  readonly attempt: number;
}

export interface ToolSelector {
  readonly provenance: SelectorProvenance;
  select(input: SelectInput): Promise<ToolChoice>;
}

/** selector를 세울 수 없다. CLI가 이 오류를 78(EX_CONFIG)로 옮긴다. */
export class SelectorUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SelectorUnavailableError";
  }
}

/** 모델 호출이 실패했다. **"틀렸다"가 아니라 "재지 못했다"이므로** CLI가 69로 옮긴다. */
export class SelectorCallError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SelectorCallError";
  }
}

/** `EVAL_TOOL_SELECTOR`. 값이 오면 그 provider를 세우려 시도한다. 비면 실 모델이 기본이다. */
export const SELECTOR_ENV = "EVAL_TOOL_SELECTOR";

/** 실 모델 경로의 provider 이름. 리포트 `selector.provider`에 그대로 실린다. */
export const ANTHROPIC_SELECTOR = "anthropic";
/** 진단 전용 경로. `--allow-oracle-selector` 없이는 고를 수 없다. */
export const ORACLE_SELECTOR = "oracle";

/**
 * 이 provider로 잰 수치를 도구 선택률로 읽어도 되는가.
 * 실제 모델이 고른 것만 참이다(`oracle`·`scripted`는 거짓).
 */
export function isTrustedSelector(provider: string): boolean {
  return provider !== "oracle" && provider !== "scripted";
}

/**
 * 도구 선택 응답의 출력 상한. 도구 호출 블록 하나에 인자를 채우는 데 필요한 만큼이다 —
 * 너무 낮으면 `max_tokens`에 걸려 잘린 호출이 "인자 누락"으로 잘못 채점된다.
 */
export const SELECT_MAX_TOKENS = 1024;

/**
 * env·인자에서 selector를 고른다. **여기가 selector를 세우는 유일한 지점이다.**
 * 세울 수 없으면 던진다 — 조용히 fake로 내려앉지 않는다.
 *
 * 순서가 의도적이다: 이름 검증 → 오라클(명시 요청) → 실 모델. 오라클을 실 모델보다 **앞**에
 * 두는 이유는 `--allow-oracle-selector`가 "판정 없이 파이프라인만 확인"이라는 결정론적 의미를
 * 가져야 하기 때문이다 — 키가 있는 머신에서만 실 모델로 바뀌면 같은 명령이 사람마다 다른 것을 잰다.
 */
export function resolveSelector(
  env: NodeJS.ProcessEnv,
  options: ResolveSelectorOptions,
): ToolSelector {
  const requested = env[SELECTOR_ENV]?.trim() ?? "";
  if (requested !== "" && requested !== ANTHROPIC_SELECTOR && requested !== ORACLE_SELECTOR) {
    throw new SelectorUnavailableError(
      `${SELECTOR_ENV}=${requested}에 해당하는 selector 구현이 없다. ` +
        `쓸 수 있는 값은 ${ANTHROPIC_SELECTOR}(기본) 또는 ${ORACLE_SELECTOR}(--allow-oracle-selector 필요)뿐이다. ` +
        "모르는 이름을 조용히 다른 것으로 바꿔 실행하면 리포트가 무엇을 잰 것인지 알 수 없다.",
    );
  }

  // 이름을 명시했으면 그것이 이긴다. `--allow-oracle-selector`는 오라클을 **허가**할 뿐
  // 명시된 provider를 갈아치우지 않는다 — 그러면 리포트가 요청과 다른 것을 잰다.
  const provider =
    requested === "" ? (options.allowOracle ? ORACLE_SELECTOR : ANTHROPIC_SELECTOR) : requested;

  if (provider === ORACLE_SELECTOR) {
    if (!options.allowOracle) {
      throw new SelectorUnavailableError(
        `${SELECTOR_ENV}=${ORACLE_SELECTOR}는 --allow-oracle-selector 없이 쓸 수 없다. ` +
          "오라클은 정의상 1.0을 내므로 env 하나로 만점 리포트가 나오면 안 된다.",
      );
    }
    return createOracleSelector(options.scenarios);
  }

  try {
    return createAnthropicSelector(createToolChoiceModel({ env }));
  } catch (error) {
    throw new SelectorUnavailableError(unavailableMessage(error), error);
  }
}

/**
 * **78의 사유는 "자격증명이 없다"이지 "인터페이스가 없다"가 아니다.**
 * T-016이 처음 쓴 문면("키를 넣어도 오늘은 잴 수 없다")은 T-039가 `ToolChoiceModel`을
 * 세운 시점에 거짓이 됐다. 거절 사유가 사실과 어긋나면 읽는 사람이 엉뚱한 것을 고치러 간다.
 */
function unavailableMessage(error: unknown): string {
  return (
    "도구 선택을 물어볼 모델을 세우지 못했다 — **자격증명·모델 설정이 없다.**\n" +
    `  사유: ${error instanceof Error ? error.message : String(error)}\n` +
    "ANTHROPIC_API_KEY와 ANTHROPIC_MODEL을 채우면 잰다(.env.example 참조). " +
    "tool-calling 인터페이스는 이미 있다 — 이 러너가 packages/core/src/llm의 " +
    "createToolChoiceModel()을 쓴다(T-039 D-7).\n" +
    "측정 없이 낸 숫자를 기준선으로 삼지 않기 위해 여기서 거절한다(specs/05, CLAUDE.md).\n" +
    "파이프라인 동작만 확인하려면 --allow-oracle-selector — 그 리포트는 trusted:false이고 " +
    "기준선 판정을 하지 않는다(그래도 종료 코드는 0이 아니라 78이다)."
  );
}

export interface ResolveSelectorOptions {
  readonly allowOracle: boolean;
  readonly scenarios: readonly Scenario[];
}

/**
 * 실 모델 selector. **specs/05의 "도구 목록만 주고 Claude에게 제시"를 그대로 옮긴다** —
 * 시스템 프롬프트도, 정답 힌트도, 시나리오 설명도 싣지 않는다. 한 글자라도 넣는 순간
 * 이 eval은 도구 description이 아니라 우리가 쓴 프롬프트를 재게 된다.
 *
 * `tool_choice`를 강제하지 않는 것은 provider 층이 이미 보장한다(T-039 A9) — 강제하면
 * 모델이 언제나 도구를 고르므로 `expectedTool: null` 시나리오가 구조적으로 통과 불가가 된다.
 */
export function createAnthropicSelector(model: ToolChoiceModel): ToolSelector {
  return {
    provenance: {
      provider: ANTHROPIC_SELECTOR,
      model: model.model,
      // 손으로 true를 쓰지 않는다 — provider 이름 하나가 신뢰 여부의 단일 소스다.
      trusted: isTrustedSelector(ANTHROPIC_SELECTOR),
    },
    async select(input: SelectInput): Promise<ToolChoice> {
      let toolUses: readonly ToolUse[];
      try {
        const response = await model.selectTool({
          messages: [{ role: "user", content: input.prompt }],
          tools: input.catalog.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          maxTokens: SELECT_MAX_TOKENS,
        });
        toolUses = response.toolUses;
      } catch (error) {
        // 모델 호출 실패는 **"틀렸다"가 아니라 "재지 못했다"**이다 — CLI가 69로 옮긴다.
        throw new SelectorCallError(
          `도구 선택 호출이 실패했다(회차 ${String(input.attempt)}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      return toToolChoice(toolUses);
    },
  };
}

/**
 * `selectTool()`의 응답 → 채점기가 받는 선택 1회.
 *
 * **빈 배열은 에러가 아니라 `{tool: null}`이다** (T-039 F-2). 여기가 그 사실이 채점기에
 * 전달되는 유일한 지점이고, 이 한 줄이 `expectedTool: null` 시나리오의 생사를 가른다.
 *
 * 도구를 둘 이상 부르면 **첫 번째만** 싣는다. `ToolChoice`가 선택 1건만 표현하기 때문이고,
 * `expectedTool: null` 갈래에서는 "무엇이든 불렀다"가 곧 오답이라 첫 건으로 충분하다.
 * (병렬 호출을 따로 세려면 리포트 스키마가 바뀌어야 한다 — 별 태스크. Findings 참조.)
 */
export function toToolChoice(toolUses: readonly ToolUse[]): ToolChoice {
  const first = toolUses[0];
  if (first === undefined) return { tool: null, args: {} };
  return { tool: first.name, args: asArgs(first.input) };
}

/**
 * 모델이 만든 `input`은 신뢰하지 않는다. 객체가 아니면 "인자를 하나도 안 채웠다"로 읽는다 —
 * 던지면 그 시도가 오답이 아니라 **측정 실패(69)**가 되어 러너 전체가 멈춘다.
 */
function asArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return { ...(input as Record<string, unknown>) };
}

/**
 * **정의상 만점을 내는** selector. 시나리오의 정답을 그대로 돌려준다.
 * 러너의 집계·리포트·가드 경로가 도는지 확인하는 용도이며 `trusted:false`다.
 * 이 selector로 낸 리포트가 통과로 읽히면 안 된다는 것이 `baseline-guard`의 첫 번째 규칙이다.
 */
export function createOracleSelector(scenarios: readonly Scenario[]): ToolSelector {
  const byPrompt = new Map(scenarios.map((scenario) => [scenario.prompt, scenario]));
  return {
    provenance: { provider: "oracle", model: "oracle", trusted: false },
    select(input: SelectInput): Promise<ToolChoice> {
      const scenario = byPrompt.get(input.prompt);
      if (scenario === undefined) {
        throw new SelectorCallError(`오라클이 모르는 프롬프트다: ${input.prompt.slice(0, 40)}…`);
      }
      if (scenario.expectedTool === null) return Promise.resolve({ tool: null, args: {} });
      const args: Record<string, unknown> = {};
      for (const name of scenario.requiredArgs) {
        args[name] = scenario.expectedArgs[name] ?? `<${name}>`;
      }
      return Promise.resolve({ tool: scenario.expectedTool, args });
    },
  };
}

/**
 * 프롬프트 → 선택을 손으로 박은 selector. **단위 테스트 전용**이다 —
 * 러너가 오답·불안정을 실제로 집계하는지 보려면 틀리는 selector가 필요하다.
 */
export function createScriptedSelector(
  script: ReadonlyMap<string, readonly ToolChoice[]>,
): ToolSelector {
  return {
    provenance: { provider: "scripted", model: "scripted", trusted: false },
    select(input: SelectInput): Promise<ToolChoice> {
      const choices = script.get(input.prompt);
      if (choices === undefined || choices.length === 0) {
        throw new SelectorCallError(`스크립트에 없는 프롬프트다: ${input.prompt.slice(0, 40)}…`);
      }
      // 반복 회차가 스크립트보다 길면 마지막 선택을 되풀이한다.
      const index = Math.min(input.attempt, choices.length) - 1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index는 위에서 범위로 잘렸다.
      return Promise.resolve(choices[index]!);
    },
  };
}
