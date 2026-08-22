/**
 * generator 배럴. 출처: specs/03-rag-pipeline.md §4, T-018.
 *
 * mongodb를 import하지 않으므로 `@sentinel/core` 메인 배럴에 실어도 안전하다
 * (`retriever/index.ts`와 같은 근거). `node:fs`는 프롬프트 파일을 읽는 데만 쓴다.
 */
export {
  NON_CLAIM_REASONS,
  splitAnswerSentences,
  stripUngroundedSentences,
  verifyAnswerCitations,
} from "./citation.js";
export type {
  AnswerSentence,
  CitationVerification,
  CitationViolation,
  NonClaimReason,
  StripResult,
} from "./citation.js";
export { GENERATOR_DEFAULTS, readGeneratorConfig } from "./config.js";
export type { GeneratorConfig, GeneratorEnvName } from "./config.js";
export { buildGenerationContext, citationFor, renderContext, renderUserMessage } from "./context.js";
export type { ContextChunk, ExcludedChunk, GenerationContext } from "./context.js";
export { GATE_OUTCOMES, evaluateThresholdGate } from "./gate.js";
export type { GateDecision, GateOutcome } from "./gate.js";
export {
  GROUNDING_VIOLATION_MESSAGE,
  MAX_REGENERATIONS,
  NOT_FOUND_MESSAGE,
  SKIP_REASONS,
  buildGateLogFields,
  buildGroundingLogFields,
  generateAnswer,
} from "./generate.js";
export type {
  FoundResult,
  GateLogFields,
  GenerateOptions,
  GenerateResult,
  GroundingLogFields,
  GroundingReport,
  NotFoundResult,
  SkipReason,
} from "./generate.js";
export {
  REQUIRED_PROMPT_CLAUSES,
  answerPromptPath,
  assertPromptClauses,
  clearAnswerPromptCache,
  findMissingClauses,
  loadAnswerPrompt,
} from "./prompt.js";
export type { RequiredPromptClauseId } from "./prompt.js";
