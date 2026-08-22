/**
 * llm 서브모듈 배럴 + env 팩토리. 출처: CLAUDE.md "LLM 호출은 `packages/core/src/llm/` 경유만 허용",
 * T-039 Scope.
 *
 * ## `fake` provider를 env로 고를 수 없다 (T-039 D-9)
 *
 * `embedder/index.ts`에는 `EMBEDDING_PROVIDER=fake` 갈래가 있고 T-006 F-8이 그 위험을 기록했다.
 * 다만 fake **임베딩**은 시끄럽게 실패한다 — 해시 벡터는 서로 다른 텍스트 간 cosine이 0 근처라
 * `SIMILARITY_THRESHOLD` 게이트가 **모든** 질의에 `found:false`를 낸다. 즉시 눈에 띈다.
 *
 * fake **생성**은 정반대다. 그럴듯한 문자열이 200 OK로 나가고 인용까지 붙어 있으므로
 * 아무도 눈치채지 못한다. 근거 없는 해결책이 정상 응답으로 유통되는 것 — NFR-02가 막으려는
 * 것이 정확히 그것이다. 그래서 `LLM_PROVIDER` env를 만들지 않았다. fake는 테스트가
 * `createFakeChatModel()`을 **직접** 부르는 경로로만 존재한다.
 */
import { createAnthropicModel } from "./anthropic.js";
import { readAnthropicConfig } from "./config.js";
import type { ToolChoiceModel } from "./tools.js";
import type { ChatModel } from "./types.js";

export { createAnthropicModel, REDACTED, redactSecret } from "./anthropic.js";
export type { AnthropicModelOptions, SdkFetch } from "./anthropic.js";
export { LLM_DEFAULTS, readAnthropicConfig } from "./config.js";
export type { AnthropicConfig } from "./config.js";
export { createFakeChatModel, createFakeToolChoiceModel } from "./fake.js";
export type {
  FakeChatModel,
  FakeChatModelOptions,
  FakeToolChoiceModel,
  FakeToolChoiceModelOptions,
} from "./fake.js";
export type {
  ToolChoiceModel,
  ToolSelectionRequest,
  ToolSelectionResponse,
  ToolSpec,
  ToolUse,
} from "./tools.js";
export { LLM_ERROR_CODES, LlmError } from "./types.js";
export type {
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  LlmErrorCode,
} from "./types.js";

export interface CreateModelOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** 테스트가 HTTP를 대체하는 지점(specs/05 결정론 원칙). */
  readonly fetch?: import("./anthropic.js").SdkFetch;
}

/**
 * 생성용 모델. 설정이 잘못됐으면 **여기서** `LlmError`로 실패한다 —
 * 첫 `/v1/answer` 요청이 올 때까지 오설정을 숨기지 않는다(`createEmbedder`와 같은 규약).
 *
 * `server.ts`가 이것을 부르므로 `ANTHROPIC_*`가 없으면 **부팅이 죽는다.** 그것이 의도다:
 * 라우트가 조용히 사라지면 드리프트 가드는 초록인데 프로덕션엔 표면이 없다(T-019 F-8).
 */
export function createChatModel(options: CreateModelOptions = {}): ChatModel {
  return createModel(options);
}

/**
 * 도구 선택용 모델(specs/05 Eval 3). `createChatModel`과 **같은 구현**을 돌려주지만
 * 반환 타입이 다르다 — 소비자가 자기 경로에서 필요한 표면만 보게 하기 위해서다(T-039 D-7).
 */
export function createToolChoiceModel(options: CreateModelOptions = {}): ToolChoiceModel {
  return createModel(options);
}

function createModel(options: CreateModelOptions): ChatModel & ToolChoiceModel {
  const config = readAnthropicConfig(options.env ?? process.env);
  return createAnthropicModel({
    ...config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
