/**
 * llm 서브모듈 배럴. 출처: CLAUDE.md "LLM 호출은 `packages/core/src/llm/` 경유만 허용".
 *
 * 실 provider는 아직 없다 — `types.ts`의 결정 D-2 참조.
 */
export { createFakeChatModel } from "./fake.js";
export type { FakeChatModel, FakeChatModelOptions } from "./fake.js";
export { LLM_ERROR_CODES, LlmError } from "./types.js";
export type {
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResponse,
  LlmErrorCode,
} from "./types.js";
