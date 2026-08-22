/**
 * "도구 목록을 주고 모델이 무엇을 고르는지 본다"의 경계면. specs/05 Eval 3:
 * > 도구 목록만 주고 Claude에게 제시 → **올바른 도구 + 필수 인자** 선택률 측정, 목표 0.9
 *
 * ---
 * ## ⚠️ 지금 이 레포에는 신뢰할 수 있는 selector 구현이 **없다** — 그래서 러너가 78로 거절한다
 *
 * 두 가지가 모두 없다. 둘 다 T-016의 권한 밖이다.
 *
 * 1. **tool-calling 가능한 `ChatModel`이 없다.** CLAUDE.md는 "LLM 호출은
 *    `packages/core/src/llm/` 경유만 허용"이라고 못박았는데, 그 인터페이스(`ChatRequest`)는
 *    `{system, messages, maxTokens}`뿐이고 **도구를 실어 보낼 자리도, 도구 호출을 돌려받을
 *    자리도 없다.** 도구 선택을 재려면 그 인터페이스가 넓어져야 하고, 그건 계약 변경이다.
 * 2. **실 provider 자체가 없다.** `packages/core/src/llm/types.ts` D-2가 명시한다 —
 *    거기에는 인터페이스와 fake뿐이고 실 provider는 "컴포지션 루트가 모델을 실제로 무는
 *    태스크(T-019)"의 몫으로 넘겨져 있다. `@anthropic-ai/sdk`는 lockfile에 없고,
 *    의존성 추가는 T-016 Scope가 아니다.
 *
 * 자격증명만의 문제가 아니라는 뜻이다. **키를 넣어도 오늘은 잴 수 없다.**
 * 그래서 이 파일은 인터페이스와 게이트만 갖고, 실 구현이 붙는 자리를 비워 둔다.
 * T-013(`eval/retrieval/args.ts`의 `assertMeasurable`)이 fake 임베딩에 대해 한 것과 같은
 * 규약이다: **잴 수 없으면 통과가 아니라 거절(78)이다.**
 *
 * ## 여기 있는 selector 둘은 전부 `trusted:false`다
 * `oracle`·`scripted`는 파이프라인이 도는지 보는 용도이지 도구 선택률을 재는 물건이 아니다.
 * 오라클은 **정의상 100%를 낸다** — 그 리포트가 기준선을 통과했다고 읽히는 순간 이 eval은
 * 거짓말이 된다. 그래서 provenance의 `trusted:false`가 회귀 가드에서 판정 자체를 막는다.
 */
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
  constructor(message: string) {
    super(message);
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

/** `EVAL_TOOL_SELECTOR`. 값이 오면 그 provider를 세우려 시도한다. */
export const SELECTOR_ENV = "EVAL_TOOL_SELECTOR";

/**
 * 이 provider로 잰 수치를 도구 선택률로 읽어도 되는가.
 * 실제 모델이 고른 것만 참이다(`oracle`·`scripted`는 거짓).
 */
export function isTrustedSelector(provider: string): boolean {
  return provider !== "oracle" && provider !== "scripted";
}

const UNAVAILABLE_MESSAGE =
  "tool-selection eval을 잴 수 있는 selector가 없다. 두 가지가 모두 빠져 있다:\n" +
  "  1) tool-calling 가능한 ChatModel — packages/core/src/llm/types.ts의 ChatRequest에는 " +
  "도구를 싣거나 도구 호출을 돌려받을 자리가 없다(계약 확장 필요).\n" +
  "  2) 실 provider 구현 — 같은 파일 D-2가 '실 provider는 T-019의 몫'으로 넘겨 뒀고 " +
  "lockfile에 LLM SDK가 없다.\n" +
  "즉 자격증명만의 문제가 아니라 **오늘은 키를 넣어도 잴 수 없다.** " +
  "측정 없이 낸 숫자를 기준선으로 삼지 않기 위해 여기서 거절한다(specs/05, CLAUDE.md).\n" +
  "파이프라인 동작만 확인하려면 --allow-oracle-selector — 그 리포트는 trusted:false이고 " +
  "기준선 판정을 하지 않는다(그래도 종료 코드는 0이 아니라 78이다).";

export interface ResolveSelectorOptions {
  readonly allowOracle: boolean;
  readonly scenarios: readonly Scenario[];
}

/**
 * env·인자에서 selector를 고른다. **여기가 selector를 세우는 유일한 지점이다.**
 * 세울 수 없으면 던진다 — 조용히 fake로 내려앉지 않는다.
 */
export function resolveSelector(
  env: NodeJS.ProcessEnv,
  options: ResolveSelectorOptions,
): ToolSelector {
  const requested = env[SELECTOR_ENV]?.trim();
  if (requested !== undefined && requested !== "") {
    // 실 provider가 생기면 여기에 분기가 붙는다. 지금은 이름을 아는 것이 없다.
    throw new SelectorUnavailableError(
      `${SELECTOR_ENV}=${requested}에 해당하는 selector 구현이 없다.\n${UNAVAILABLE_MESSAGE}`,
    );
  }
  if (!options.allowOracle) throw new SelectorUnavailableError(UNAVAILABLE_MESSAGE);
  return createOracleSelector(options.scenarios);
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
