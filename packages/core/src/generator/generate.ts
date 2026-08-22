/**
 * 답변 생성. 출처: specs/03-rag-pipeline.md §4, NFR-02·NFR-05, T-018 Scope.
 *
 * 흐름은 세 단계이고 **순서가 계약이다**:
 *   1. 임계값 게이트 → 미달이면 여기서 끝. 모델을 **부르지 않는다**.
 *   2. 컨텍스트 조립(`injection-suspect` 제외) → 남은 청크가 0이면 여기서 끝. 역시 안 부른다.
 *   3. 프롬프트 + 컨텍스트로 1회 호출.
 *
 * ## "부르지 않는다"가 "부르고 버린다"와 다른 이유 (Acceptance 1)
 *
 * 임계값 미달은 **비용을 쓰지 않는 것**이 목적이다. 호출한 뒤 결과를 버리면 토큰은 이미
 * 나갔고, 무관한 질의가 쏟아질 때 그 비용이 그대로 샌다. 게다가 근거가 임계값에 못 미치는
 * 상태에서 모델이 답을 만들어 두면, 나중 누군가 "이미 있으니 쓰자"고 꺼내 쓸 여지가 남는다 —
 * NFR-02가 막으려는 것이 정확히 그것이다. 그래서 `model.complete`는 게이트 뒤에만 있다.
 */
import type { ChatModel } from "../llm/types.js";
import { LLM_ERROR_CODES, LlmError } from "../llm/types.js";
import type { RetrievalResult } from "../retriever/types.js";
import { readGeneratorConfig, type GeneratorConfig } from "./config.js";
import { buildGenerationContext, renderUserMessage, type ExcludedChunk } from "./context.js";
import { evaluateThresholdGate, type GateDecision } from "./gate.js";
import { loadAnswerPrompt } from "./prompt.js";

/**
 * 게이트에 걸렸을 때 돌려주는 문구. specs/03 §4의
 * `{found:false, suggestRecord:true, message:"유사 사례 없음"}`이다.
 */
export const NOT_FOUND_MESSAGE = "유사 사례 없음";

/** 게이트가 아니라 "컨텍스트가 비었다"로 끝난 경우의 사유. */
export const SKIP_REASONS = {
  /** 임계값 미달. */
  BELOW_THRESHOLD: "below-threshold",
  /** 게이트는 통과했지만 인용 가능한 청크가 하나도 남지 않았다. */
  NO_USABLE_CONTEXT: "no-usable-context",
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

export interface NotFoundResult {
  readonly found: false;
  readonly suggestRecord: true;
  readonly message: string;
  readonly skipReason: SkipReason;
  readonly gate: GateDecision;
  /** 컨텍스트에서 제외된 청크. 게이트 통과 후 비었을 때 "왜"를 되짚는 근거다. */
  readonly excluded: ExcludedChunk[];
}

export interface FoundResult {
  readonly found: true;
  readonly answer: string;
  readonly gate: GateDecision;
  /** 컨텍스트에 실제로 들어간 청크의 인용 ID. T-020의 검증 대상 집합이 이것이다. */
  readonly citations: string[];
  readonly contextChunkIds: string[];
  readonly excluded: ExcludedChunk[];
  readonly model: string;
}

export type GenerateResult = NotFoundResult | FoundResult;

export interface GenerateOptions {
  readonly query: string;
  readonly retrieval: RetrievalResult;
  readonly model: ChatModel;
  /** 미지정이면 env에서 읽는다. 테스트·eval이 임계값을 흔드는 지점이다. */
  readonly config?: GeneratorConfig;
}

export async function generateAnswer(options: GenerateOptions): Promise<GenerateResult> {
  const config = options.config ?? readGeneratorConfig();
  const { retrieval, model } = options;

  // 1. 게이트. `maxVectorScore`만 넘긴다 — hits도 fusedScore도 여기 오지 않는다.
  const gate = evaluateThresholdGate(retrieval.maxVectorScore, config.similarityThreshold);

  // 2. 컨텍스트는 게이트 판정 뒤에 조립한다. 순서를 뒤집어도 결과는 같지만,
  //    "게이트가 먼저"라는 것이 코드에서 읽혀야 다음 사람이 호출을 게이트 앞으로 옮기지 않는다.
  const context = buildGenerationContext(retrieval.hits);

  if (!gate.passed) {
    return notFound(SKIP_REASONS.BELOW_THRESHOLD, gate, context.excluded);
  }

  // 3. `injection-suspect`를 걷어낸 뒤 아무것도 안 남는 경우가 실재한다(T-021의 오염 시드).
  //    근거가 없으면 답도 없다 — 이것도 모델을 부르지 않는 갈래다(NFR-02).
  if (context.chunks.length === 0) {
    return notFound(SKIP_REASONS.NO_USABLE_CONTEXT, gate, context.excluded);
  }

  const response = await model.complete({
    system: loadAnswerPrompt(),
    messages: [{ role: "user", content: renderUserMessage(options.query, context) }],
    maxTokens: config.answerMaxTokens,
  });

  const answer = response.text.trim();
  if (answer.length === 0) {
    throw new LlmError(
      LLM_ERROR_CODES.RESPONSE_EMPTY,
      "모델이 빈 응답을 돌려줬다 — 근거가 있어도 답이 없으면 답이 아니다.",
    );
  }

  return {
    found: true,
    answer,
    gate,
    citations: context.chunks.map((chunk) => chunk.citation),
    contextChunkIds: context.chunks.map((chunk) => chunk.chunkId),
    excluded: context.excluded,
    model: response.model,
  };
}

function notFound(
  skipReason: SkipReason,
  gate: GateDecision,
  excluded: ExcludedChunk[],
): NotFoundResult {
  return {
    found: false,
    suggestRecord: true,
    message: NOT_FOUND_MESSAGE,
    skipReason,
    gate,
    excluded,
  };
}

/**
 * 게이트 판정을 평평한 로그 필드로 편다. 출처: T-011 F-B 결정
 * "판정 불가가 응답이나 로그에 남아야 튜닝이 가능하다".
 *
 * 필드 이름을 여기서 고정하는 이유: 호출자(T-019)가 각자 이름을 지으면 T-013의 스윕이
 * 로그를 가로질러 집계할 수 없다. `api/search.ts`의 `buildSearchLogFields`와 같은 규약으로
 * **순수 함수**다 — 라우트에 인라인하면 필드 하나가 빠져도 아무 테스트도 깨지지 않는다.
 */
export interface GateLogFields {
  readonly gateOutcome: string;
  readonly gatePassed: boolean;
  readonly gateThresholdEvaluated: boolean;
  readonly gateMaxVectorScore: number | null;
  readonly gateThreshold: number;
}

export function buildGateLogFields(gate: GateDecision): GateLogFields {
  return {
    gateOutcome: gate.outcome,
    gatePassed: gate.passed,
    gateThresholdEvaluated: gate.thresholdEvaluated,
    gateMaxVectorScore: gate.maxVectorScore,
    gateThreshold: gate.threshold,
  };
}
