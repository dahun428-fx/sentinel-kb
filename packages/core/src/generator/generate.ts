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
 *
 * ## T-020 갱신: 4단계가 붙었다 — 인용 후처리 검증 (specs/03 §5)
 *
 * 순서는 여전히 계약이고, 새 단계는 **게이트 뒤·응답 앞**에 들어간다:
 *   4. 답변의 주장 문장마다 유효한 `[REC-...#...]`이 있고 그 ID가 **실제 컨텍스트에 있었는지**
 *      확인 → 위반이면 **1회 재생성** → 재차 위반이면 위반 문장을 제거하고 `groundingViolation`.
 *
 * 게이트 앞으로 옮길 수 없다(검증할 답이 아직 없다). 응답 뒤로 미룰 수도 없다 —
 * `/v1/answer`가 SSE를 열고 나면 검증 결과로 되돌릴 수 있는 것이 없다(T-019의 순서 계약).
 *
 * ### 비용: 최악이 2배가 된다 (NFR-01)
 * 재생성은 모델 호출을 1회 더 쓴다. T-039가 시도당 타임아웃 8s × 최대 2시도로 잡았으므로
 * 생성 1건의 최악은 16s였고, 재생성이 붙으면 **32s**가 된다. 다만 (a) 재생성은 위반이
 * 났을 때만 발생하므로 p50·p95는 거의 움직이지 않고, (b) MCP 클라이언트의 시도당 타임아웃이
 * 10s라 16s든 32s든 **아무도 받지 못하는 것은 마찬가지**다. NFR-01(p95 < 2s)은 T-039 F-1이
 * 이미 미성립으로 보고한 상태이며, 이 태스크는 그 결론을 바꾸지 않고 **최악값만 2배로
 * 악화시킨다.** 그 사실을 숨기지 않고 여기 적어 둔다(T-020 Findings).
 */
import type { ChatMessage, ChatModel } from "../llm/types.js";
import { LLM_ERROR_CODES, LlmError } from "../llm/types.js";
import type { RetrievalResult } from "../retriever/types.js";
import {
  stripUngroundedSentences,
  verifyAnswerCitations,
  type CitationVerification,
} from "./citation.js";
import { readGeneratorConfig, type GeneratorConfig } from "./config.js";
import { buildGenerationContext, renderUserMessage, type ExcludedChunk } from "./context.js";
import { evaluateThresholdGate, type GateDecision } from "./gate.js";
import { loadAnswerPrompt } from "./prompt.js";

/**
 * 게이트에 걸렸을 때 돌려주는 문구. specs/03 §4의
 * `{found:false, suggestRecord:true, message:"유사 사례 없음"}`이다.
 */
export const NOT_FOUND_MESSAGE = "유사 사례 없음";

/**
 * 인용 검증이 끝내 실패했을 때의 문구. **`NOT_FOUND_MESSAGE`와 다른 문장인 것이 요점이다** —
 * 유사 사례는 있었고, 없는 것은 근거에 묶인 답이다. 두 갈래를 같은 문구로 접으면
 * 사용자는 검색이 실패했다고 믿고 같은 질의를 반복한다.
 */
export const GROUNDING_VIOLATION_MESSAGE =
  "검색된 사례는 있으나 근거에 묶인 답변을 만들지 못했다";

/**
 * specs/03 §5가 정한 재생성 횟수. **"1회"는 스펙 문면이지 튜닝 값이 아니다** —
 * env로 열면 0으로 꺼서 검증을 무력화하거나 5로 올려 타임아웃을 태울 수 있다.
 */
export const MAX_REGENERATIONS = 1;

/** 게이트·컨텍스트·인용 검증 중 어디서 끝났는가. */
export const SKIP_REASONS = {
  /** 임계값 미달. */
  BELOW_THRESHOLD: "below-threshold",
  /** 게이트는 통과했지만 인용 가능한 청크가 하나도 남지 않았다. */
  NO_USABLE_CONTEXT: "no-usable-context",
  /**
   * 재생성 뒤에도 위반이 남아 문장을 제거했더니 **근거에 묶인 주장이 하나도 남지 않았다**.
   * specs/03 §5는 이 경우를 정하지 않았다 — 결정과 근거는 `notGrounded` 주석 참조.
   */
  GROUNDING_VIOLATION: "grounding-violation",
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

/**
 * 인용 후처리 검증의 결과 요약(specs/03 §5). **`null`은 "검증까지 가지 않았다"이지
 * "위반이 없었다"가 아니다** — 게이트 필드가 `thresholdEvaluated`를 따로 두는 것과 같은 이유다.
 */
export interface GroundingReport {
  /** specs/03 §5의 `groundingViolation`. 재생성 뒤에도 위반이 남았다는 뜻이다. */
  readonly violation: boolean;
  /** 재생성이 실제로 일어났는가. 위반이 1차에서만 났고 2차가 깨끗하면 `true`+`violation:false`다. */
  readonly regenerated: boolean;
  readonly claimSentences: number;
  readonly citedSentences: number;
  /** 제거된 문장 수. `violation:false`면 0이다. */
  readonly removedSentences: number;
  /** **컨텍스트에 없는데 인용된 ID.** 모델이 지어낸 것이고, 비어 있지 않으면 그 자체가 사건이다. */
  readonly unknownCitations: string[];
}

export interface NotFoundResult {
  readonly found: false;
  readonly suggestRecord: true;
  readonly message: string;
  readonly skipReason: SkipReason;
  readonly gate: GateDecision;
  /** 컨텍스트에서 제외된 청크. 게이트 통과 후 비었을 때 "왜"를 되짚는 근거다. */
  readonly excluded: ExcludedChunk[];
  /** 생성까지 가지 않았으면 `null`. */
  readonly grounding: GroundingReport | null;
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
  /** 답변까지 갔으므로 언제나 존재한다. */
  readonly grounding: GroundingReport;
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
    return notFound(SKIP_REASONS.BELOW_THRESHOLD, NOT_FOUND_MESSAGE, gate, context.excluded, null);
  }

  // 3. `injection-suspect`를 걷어낸 뒤 아무것도 안 남는 경우가 실재한다(T-021의 오염 시드).
  //    근거가 없으면 답도 없다 — 이것도 모델을 부르지 않는 갈래다(NFR-02).
  if (context.chunks.length === 0) {
    return notFound(
      SKIP_REASONS.NO_USABLE_CONTEXT,
      NOT_FOUND_MESSAGE,
      gate,
      context.excluded,
      null,
    );
  }

  const system = loadAnswerPrompt();
  const allowed = context.chunks.map((chunk) => chunk.citation);
  const userMessage = renderUserMessage(options.query, context);

  const first = await complete(model, system, [{ role: "user", content: userMessage }], config);
  let answer = first.text;
  let verification = verifyAnswerCitations(answer, allowed);

  /*
   * 4. **위반 시 1회 재생성**(specs/03 §5). 직전 답변을 대화에 되싣고 무엇이 틀렸는지 알려
   *    다시 쓰게 한다. 같은 프롬프트로 그냥 한 번 더 부르는 것은 재생성이 아니라 재추첨이다 —
   *    모델은 자기가 무엇을 어겼는지 모른 채 같은 실수를 반복한다.
   *    지시문에는 **청크 본문이 들어가지 않는다.** 인용 ID 목록과 위반 건수뿐이다(NFR-03).
   */
  let regenerated = false;
  for (let attempt = 0; attempt < MAX_REGENERATIONS && !verification.ok; attempt += 1) {
    regenerated = true;
    const retry = await complete(
      model,
      system,
      [
        { role: "user", content: userMessage },
        { role: "assistant", content: answer },
        { role: "user", content: regenerationInstruction(verification, allowed) },
      ],
      config,
    );
    answer = retry.text;
    verification = verifyAnswerCitations(answer, allowed);
  }

  const base = {
    gate,
    citations: allowed,
    contextChunkIds: context.chunks.map((chunk) => chunk.chunkId),
    excluded: context.excluded,
    model: first.model,
  } as const;

  if (verification.ok) {
    return {
      found: true,
      answer,
      ...base,
      grounding: report(verification, { regenerated, violation: false, removed: 0 }),
    };
  }

  /*
   * 5. **재차 위반이면 인용 없는 문장을 제거하고 `groundingViolation: true`**(specs/03 §5).
   *    남은 조각은 모델이 쓴 그대로다 — 우리가 문장을 고쳐 쓰면 그건 근거 검증이 아니라 대필이다.
   */
  const stripped = stripUngroundedSentences(answer, verification);
  const grounding = report(verification, {
    regenerated,
    violation: true,
    removed: stripped.removed,
  });

  /*
   * **제거하고 나니 근거에 묶인 주장이 하나도 안 남은 경우.** specs/03 §5는 이 상태를
   * 정하지 않았다. **결정: `found:true`로 낼 수 없다.**
   *
   *  (a) 계약이 애초에 허용하지 않는다 — `AnswerResponse`의 found:true 갈래는
   *      `answer: z.string().min(1)`이라 빈 문자열은 파싱에서 죽고 500이 된다.
   *      500은 "근거가 없어 답하지 않았다"가 아니라 "서버가 고장 났다"로 읽힌다.
   *  (b) 빈 문자열이 아니라 인사말·제목만 남는 경우가 더 위험하다. 인용 배열은 컨텍스트에서
   *      나오므로 여전히 비어 있지 않고, 그대로 내보내면 **본문은 아무것도 주장하지 않는데
   *      인용은 붙어 있는** 응답이 된다 — T-019 M5b가 정확히 그 상태였다.
   *  (c) `found:false`는 이미 계약에 있는 갈래이고 `suggestRecord:true`가 붙는다.
   *      근거를 확인할 수 없었다면 기록할 가치가 있다는 뜻이므로 의미도 맞는다.
   *
   * 메시지는 `NOT_FOUND_MESSAGE`가 아니다. 유사 사례는 **있었다** — 못 만든 것은 답이다.
   * "유사 사례 없음"으로 접으면 임계값 미달과 구별되지 않고, 사용자는 검색이 실패했다고 믿는다.
   */
  if (!stripped.grounded) {
    return notFound(
      SKIP_REASONS.GROUNDING_VIOLATION,
      GROUNDING_VIOLATION_MESSAGE,
      gate,
      context.excluded,
      grounding,
    );
  }

  return { found: true, answer: stripped.text, ...base, grounding };
}

/** 모델 1회 호출 + 빈 응답 거부. 첫 호출과 재생성이 같은 규칙을 쓰게 한 곳이다. */
async function complete(
  model: ChatModel,
  system: string,
  messages: ChatMessage[],
  config: GeneratorConfig,
): Promise<{ text: string; model: string }> {
  const response = await model.complete({ system, messages, maxTokens: config.answerMaxTokens });
  const text = response.text.trim();
  if (text.length === 0) {
    throw new LlmError(
      LLM_ERROR_CODES.RESPONSE_EMPTY,
      "모델이 빈 응답을 돌려줬다 — 근거가 있어도 답이 없으면 답이 아니다.",
    );
  }
  return { text, model: response.model };
}

/**
 * 재생성 지시문. **결정론적이다** — 같은 위반이면 같은 문장이 나가야 eval이 재현된다.
 * 위반 문장 원문은 싣지 않는다: 직전 답변이 바로 위 턴에 그대로 있으므로 중복이고,
 * 길어지면 재생성이 첫 호출보다 비싸진다.
 */
function regenerationInstruction(
  verification: CitationVerification,
  allowed: readonly string[],
): string {
  const missing = verification.violations.filter((v) => v.kind === "missing").length;
  const unknown = verification.violations.filter((v) => v.kind === "unknown").length;
  return [
    "직전 답변이 인용 규칙(시스템 프롬프트 조항 2)을 어겼다. 다시 써라.",
    `- 인용이 없는 주장 문장: ${String(missing)}건`,
    `- 제공되지 않은 인용 ID를 쓴 문장: ${String(unknown)}건` +
      (verification.unknownCitations.length > 0
        ? ` (${verification.unknownCitations.join(", ")})`
        : ""),
    "사용할 수 있는 인용은 아래가 전부다. 그대로 복사해 쓰고, 여기 없는 ID는 만들지 마라.",
    allowed.join("\n"),
    "모든 주장 문장은 이 중 하나 이상의 인용으로 끝나야 한다. " +
      "인용을 붙일 수 없는 내용은 쓰지 말고, 기록된 사례로 덮이지 않는 부분은 그렇다고 밝혀라.",
  ].join("\n");
}

function report(
  verification: CitationVerification,
  outcome: { regenerated: boolean; violation: boolean; removed: number },
): GroundingReport {
  return {
    violation: outcome.violation,
    regenerated: outcome.regenerated,
    claimSentences: verification.claimCount,
    citedSentences: verification.citedClaimCount,
    removedSentences: outcome.removed,
    unknownCitations: verification.unknownCitations,
  };
}

function notFound(
  skipReason: SkipReason,
  message: string,
  gate: GateDecision,
  excluded: ExcludedChunk[],
  grounding: GroundingReport | null,
): NotFoundResult {
  return {
    found: false,
    suggestRecord: true,
    message,
    skipReason,
    gate,
    excluded,
    grounding,
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

/**
 * 인용 검증 결과의 평평한 로그 필드. specs/03 §5의 **"`groundingViolation: true` 로깅"이
 * 실제로 이행되는 지점이다.** `buildGateLogFields`와 같은 규약으로 순수 함수이며, 이름을
 * 호출자가 각자 짓지 못하게 여기서 고정한다 — 그래야 수집기가 로그를 가로질러 셀 수 있다.
 *
 * **`null` 입력은 전부 `null`을 낸다. `false`가 아니다.** 게이트에서 걸려 생성까지 가지 않은
 * 요청과 "검증했고 위반이 없었다"를 같은 `false`로 접으면, 위반율 집계의 분모가 조용히
 * 부풀고 `groundingViolation`이 실제보다 드물어 보인다 — 판정 불가를 통과로 접는
 * 감사 B-1의 그 오류와 같은 종류다.
 */
export interface GroundingLogFields {
  /** specs/03 §5의 그 필드. `true`면 재생성 뒤에도 위반이 남아 문장을 제거했다는 뜻이다. */
  readonly groundingViolation: boolean | null;
  readonly groundingRegenerated: boolean | null;
  readonly groundingClaimSentences: number | null;
  readonly groundingCitedSentences: number | null;
  readonly groundingRemovedSentences: number | null;
  /** 지어낸 인용 ID의 수. **개수만 남긴다** — ID 원문은 답변 본문의 일부다. */
  readonly groundingUnknownCitations: number | null;
}

export function buildGroundingLogFields(
  grounding: GroundingReport | null,
): GroundingLogFields {
  if (grounding === null) {
    return {
      groundingViolation: null,
      groundingRegenerated: null,
      groundingClaimSentences: null,
      groundingCitedSentences: null,
      groundingRemovedSentences: null,
      groundingUnknownCitations: null,
    };
  }
  return {
    groundingViolation: grounding.violation,
    groundingRegenerated: grounding.regenerated,
    groundingClaimSentences: grounding.claimSentences,
    groundingCitedSentences: grounding.citedSentences,
    groundingRemovedSentences: grounding.removedSentences,
    groundingUnknownCitations: grounding.unknownCitations.length,
  };
}
