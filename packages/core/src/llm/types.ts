/**
 * LLM 호출 계층의 공통 타입. 출처: CLAUDE.md 코드 규칙, specs/05 "결정론 원칙".
 *
 * ## 왜 이 디렉터리가 T-018에서 생기는가 (결정 D-1)
 *
 * CLAUDE.md는 "**LLM 호출은 `packages/core/src/llm/` 경유만 허용**. 다른 데서 SDK를 직접
 * 부르지 않는다"라고 못박아 두었지만 이 디렉터리는 여태 비어 있었다. T-018이 §4의
 * "생성"을 구현하는 **첫 태스크**이므로 여기서 만든다. generator 안에 HTTP 호출을 두면
 * 그 규칙이 첫 사용처에서 곧바로 깨지고, 이후 T-019(SSE)·T-020(재생성)·T-030대(작성
 * 파이프라인)가 각자 자기 자리에 provider를 복제한다.
 *
 * ## 여기에 **실제 provider는 없다** (결정 D-2)
 *
 * 이 디렉터리는 `ChatModel` 인터페이스와 fake만 담는다. 실 provider(Anthropic)를 T-018이
 * 함께 넣지 않는 이유는 둘이다.
 *
 *  1. **의존성 추가는 이 태스크의 권한 밖이다.** T-018 Scope는 "컨텍스트 조립 + 시스템
 *     프롬프트 + 호출"이고, 여기서 "호출"은 generator가 주입된 `ChatModel`을 부르는 것을
 *     뜻한다. `@anthropic-ai/sdk`를 물리는 것은 lockfile을 바꾸는 별개의 결정이다.
 *  2. **`embedder/voyage.ts`의 raw-fetch 선례를 LLM 쪽으로 복사하면 안 된다.**
 *     그 선례의 근거는 "provider 교체(NFR-06)가 SDK 버전에 막히지 않게"였고 임베딩에는
 *     타당하다. 그러나 Anthropic Messages API는 공식 TS SDK가 있고 파라미터 계약이
 *     세대마다 움직인다(thinking·effort·max_tokens 규칙). 손으로 만든 fetch 클라이언트는
 *     그 변화를 조용히 놓친다. 실 provider를 붙일 때는 공식 SDK를 써야 한다.
 *
 * 따라서 실 provider는 **컴포지션 루트가 모델을 실제로 물리는 태스크**(T-019 `/v1/answer`)의
 * 몫으로 넘긴다. generator는 `ChatModel`만 알면 되고, 그 경계 덕분에 T-018의 단위 테스트는
 * 처음부터 fake로 결정론적이다(specs/05). 인계 사항은 T-018 Findings에 적었다.
 *
 * ## T-039 갱신: 실 provider가 `anthropic.ts`에 들어왔다
 *
 * 위 D-2의 "여기에 실제 provider는 없다"는 **더 이상 사실이 아니다.** T-019가 그 몫을 지지
 * 못한 이유(budget 밖)는 정당했고, T-039가 그 자리를 채웠다. D-2가 지시한 대로 **공식
 * SDK**(`@anthropic-ai/sdk`)를 쓴다 — raw fetch 선례는 임베딩에 한정된다.
 *
 * **이 파일의 타입은 그대로다.** 도구 선택(specs/05 Eval 3)은 `ChatRequest`에 필드를 더하는
 * 대신 `tools.ts`의 별도 인터페이스로 갔다 — 근거는 T-039 D-7.
 */

/** 모델에 보내는 메시지 1건. system은 별도 필드라 여기 오지 않는다. */
export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * **`temperature`가 없는 것은 누락이 아니다.** 현행 Claude 모델(Opus 5·Sonnet 5·4.7+)은
 * `temperature`·`top_p`·`top_k`를 아예 받지 않고 400으로 거절한다. 이 인터페이스에 필드를
 * 두면 provider 구현자가 "채워야 하는 값"으로 읽고 그대로 실어 보내 요청이 죽는다.
 * 생성의 결정론은 온도가 아니라 fake 주입(specs/05)으로 얻는다.
 */
export interface ChatRequest {
  /** 시스템 프롬프트. generator는 `prompts/answer.md`를 그대로 싣는다. */
  readonly system: string;
  readonly messages: ChatMessage[];
  readonly maxTokens: number;
}

export interface ChatResponse {
  readonly text: string;
  /** provider가 알려 준 모델 식별자. 로그·eval 리포트가 세대를 구분하는 근거다. */
  readonly model: string;
  readonly stopReason: string | null;
}

/**
 * 텍스트 생성의 유일한 통로. `Embedder`와 같은 규약이다 —
 * unit/integration은 fake를 주입하고, 실제 모델 호출은 eval 계층에서만 일어난다(specs/05).
 */
export interface ChatModel {
  complete(request: ChatRequest): Promise<ChatResponse>;
  /** 모델 세대. 진단·리포트용이며 튜닝 대상이 아니다. */
  readonly model: string;
}

export const LLM_ERROR_CODES = {
  /** 모델 호출이 실패했다. generator는 이 실패를 삼키지 않고 호출자에게 올린다. */
  REQUEST_FAILED: "LLM_REQUEST_FAILED",
  /** 응답에 텍스트가 없다 — 인용할 근거가 있어도 답이 없으면 답이 아니다. */
  RESPONSE_EMPTY: "LLM_RESPONSE_EMPTY",
  /** 모델 ID가 env에 없다. 코드에 기본값을 두지 않는다 (T-039 D-2, `EMBEDDING_MODEL`과 같은 규약). */
  MODEL_MISSING: "LLM_MODEL_MISSING",
  /** API 키가 env에 없다. 시크릿 하드코딩 금지 — SSM/.env로만 주입한다(specs/06). */
  API_KEY_MISSING: "LLM_API_KEY_MISSING",
} as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[keyof typeof LLM_ERROR_CODES];

/** LLM 계층의 모든 실패를 코드로 식별 가능하게 감싼다 (`EmbedderError`와 같은 규약). */
export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LlmError";
    this.code = code;
  }
}
