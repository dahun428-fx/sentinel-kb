/**
 * embedder 공통 타입. 출처: specs/tasks/T-006-embedder.md Scope, specs/03-rag-pipeline.md, NFR-06.
 *
 * 이 타입들은 **core 내부 계약**이다. `packages/contracts`는 HTTP·MCP가 주고받는
 * 외부 계약만 담으므로(CLAUDE.md) 임베딩 provider 인터페이스는 여기 남는다.
 *
 * CLAUDE.md는 "LLM 호출은 packages/core/src/llm/ 경유만 허용"이라고 못박지만,
 * **임베딩 호출은 `embedder` 인터페이스 경유**가 별도 규칙이다. 따라서 임베딩 API를
 * 직접 때리는 코드가 사는 자리는 `llm/`이 아니라 이 디렉터리이며, 여기 밖에서
 * 임베딩 엔드포인트를 부르는 코드는 규칙 위반이다.
 */

/**
 * 텍스트 배치를 벡터로 바꾸는 유일한 통로.
 *
 * `version`은 **이 embedder가 만든 벡터의 모델 세대**(`EMBEDDING_VERSION`)다.
 * specs/02 "마이그레이션 규칙"이 요구하는 무중단 재임베딩(신규 버전 삽입 → 검색 필터
 * 스왑 → 구버전 삭제, 인플레이스 갱신 금지)에서는 같은 record가 구·신 버전 청크를
 * 동시에 갖는 것이 **정상 동작**이다. 그러므로 `chunk.embeddingVersion`의 소스는
 * record가 아니라 여기다 — 청크에 붙는 버전은 "그 벡터를 만든 모델 세대"를 뜻한다.
 * (T-005 Findings F-1 해소. `record.embeddingVersion`의 의미는 T-008에서 결정한다.)
 */
export interface Embedder {
  /** 입력 순서를 보존해 벡터를 돌려준다. `texts[i]` ↔ 반환값 `[i]`. */
  embed(texts: string[]): Promise<number[][]>;
  /** 벡터 차원. specs/02의 `vec_idx` dim과 반드시 같아야 한다. */
  dim: number;
  /** 모델 세대. 청크의 `embeddingVersion`으로 그대로 기록된다. */
  version: number;
}

/** 임베딩 계층 실패 원인 코드. 호출자(T-008 워커)가 재큐잉 여부를 분기하는 기준이다. */
export const EMBEDDER_ERROR_CODES = {
  /** `EMBEDDING_PROVIDER` 값이 지원 목록 밖 — 설정 실수. */
  PROVIDER_UNKNOWN: "EMBEDDER_PROVIDER_UNKNOWN",
  /** API 키 미설정 — **생성 시점**에 던진다. 런타임에 조용히 죽지 않게. */
  API_KEY_MISSING: "EMBEDDER_API_KEY_MISSING",
  /** `EMBEDDING_MODEL` 미설정 — 모델명은 코드가 아니라 env가 소스다. */
  MODEL_MISSING: "EMBEDDER_MODEL_MISSING",
  /** `EMBEDDING_DIM`이 없거나 양의 정수가 아님. 기본값을 두지 않는다(모델이 정하는 값). */
  DIM_INVALID: "EMBEDDER_DIM_INVALID",
  /** `EMBEDDING_VERSION`이 없거나 양의 정수가 아님. 잘못 기본값을 주면 버전이 섞인다. */
  VERSION_INVALID: "EMBEDDER_VERSION_INVALID",
  /** 재시도해도 결과가 같은 실패(429 제외 4xx). 워커는 즉시 failed 처리해야 한다. */
  REQUEST_FAILED: "EMBEDDER_REQUEST_FAILED",
  /** 429/5xx를 지수백오프로 다 소진 — 일시 장애일 수 있으니 재큐잉 여지가 있다. */
  RETRY_EXHAUSTED: "EMBEDDER_RETRY_EXHAUSTED",
  /** 응답 JSON 형상·개수·차원이 계약과 다름. */
  RESPONSE_INVALID: "EMBEDDER_RESPONSE_INVALID",
} as const;

export type EmbedderErrorCode = (typeof EMBEDDER_ERROR_CODES)[keyof typeof EMBEDDER_ERROR_CODES];

/** 임베딩 계층의 모든 실패를 코드로 식별 가능하게 감싼다 (T-003 `DbConnectionError`와 같은 규약). */
export class EmbedderError extends Error {
  readonly code: EmbedderErrorCode;

  constructor(code: EmbedderErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EmbedderError";
    this.code = code;
  }
}

/**
 * 주입 가능한 HTTP 응답의 최소 형상. `globalThis.fetch`의 `Response`가 구조적으로 만족한다.
 * 테스트는 실제 API를 부르지 않으므로(specs/05 결정론 원칙) 이 형상만 흉내내면 된다.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** 주입 가능한 fetch. 기본값은 `globalThis.fetch`. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<HttpResponseLike>;

/**
 * 주입 가능한 대기 함수. 기본값은 실제 `setTimeout`이고, 테스트는 즉시 resolve하는
 * 스텁을 넣어 백오프 대기를 실제로 기다리지 않는다(테스트가 수 초씩 걸리지 않게).
 */
export type SleepFn = (ms: number) => Promise<void>;

/** 기본 sleep — 실제 타이머. */
export const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
