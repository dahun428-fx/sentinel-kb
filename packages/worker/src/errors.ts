/**
 * 워커 고유 실패와 **재시도 판정**. 출처: specs/03-rag-pipeline.md §1-4,
 * T-008 Findings(T-006 인계: "에러 코드로 재시도 여부를 가른다").
 *
 * 판정의 목적은 하나다 — **재시도해도 결과가 같은 실패에 attempts를 태우지 않는 것.**
 * 오설정(`API_KEY_MISSING` 등)은 부팅 시 embedder 생성에서 이미 걸러지지만(worker.cli.ts),
 * 그물을 여기에도 쳐 둔다. 설정 계열이 런타임까지 새어 들어오면 큐 전체가
 * `attempts++ → dead`로 조용히 소각되기 때문이다.
 */
import { EMBEDDER_ERROR_CODES } from "@sentinel/core";

export const WORKER_ERROR_CODES = {
  /** job.recordId가 가리키는 record가 없다. 재시도해도 생기지 않는다. */
  RECORD_NOT_FOUND: "WORKER_RECORD_NOT_FOUND",
  /** record 도큐먼트가 `RecordSchema`를 만족하지 않는다. 데이터 결함이라 영구 실패다. */
  RECORD_INVALID: "WORKER_RECORD_INVALID",
  /** 임베딩 벡터 개수가 청크 수와 다르다. embedder 계약 위반 — 재시도 무의미. */
  EMBEDDING_COUNT_MISMATCH: "WORKER_EMBEDDING_COUNT_MISMATCH",
} as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];

/** 워커 계층의 실패를 코드로 식별 가능하게 감싼다 (`DbConnectionError`·`EmbedderError`와 같은 규약). */
export class WorkerError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkerError";
    this.code = code;
  }
}

/**
 * 재시도해도 같은 결과가 나오는 실패들.
 *
 * `EMBEDDER_RETRY_EXHAUSTED`는 **의도적으로 빠져 있다** — 429/5xx를 백오프로 소진한 것이라
 * 일시 장애일 수 있고, 재큐잉 여지가 있다(T-006 인계). 목록에 없는 모든 실패
 * (DB 순단, 예기치 못한 예외)도 같은 이유로 일시 실패로 본다: 영구로 오판하면
 * 회복 가능한 잡을 버리게 된다.
 */
const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  EMBEDDER_ERROR_CODES.PROVIDER_UNKNOWN,
  EMBEDDER_ERROR_CODES.API_KEY_MISSING,
  EMBEDDER_ERROR_CODES.MODEL_MISSING,
  EMBEDDER_ERROR_CODES.DIM_INVALID,
  EMBEDDER_ERROR_CODES.VERSION_INVALID,
  EMBEDDER_ERROR_CODES.REQUEST_FAILED,
  EMBEDDER_ERROR_CODES.RESPONSE_INVALID,
  // chunker 설정 결함(`CHUNK_MAX_CHARS`가 제목 길이를 감당 못 함). core의 ChunkBudgetError.code.
  "CHUNK_BUDGET_TOO_SMALL",
  WORKER_ERROR_CODES.RECORD_NOT_FOUND,
  WORKER_ERROR_CODES.RECORD_INVALID,
  WORKER_ERROR_CODES.EMBEDDING_COUNT_MISMATCH,
]);

/**
 * `code` 문자열만 본다. `instanceof`로 갈랐다면 core를 두 번 로드하는 환경(중복 설치·번들 분리)에서
 * 판정이 조용히 뒤집힌다. 코드 규약(`DbConnectionError`·`EmbedderError`·`ChunkBudgetError`가
 * 모두 `code`를 노출)이 이미 있으므로 그 규약에만 기댄다.
 */
export function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** 이 실패에 재시도를 붙일 가치가 있는가. `true`면 재큐잉 없이 종착 상태로 보낸다. */
export function isPermanentFailure(error: unknown): boolean {
  const code = readErrorCode(error);
  return code !== undefined && PERMANENT_ERROR_CODES.has(code);
}

/** `jobs.lastError`에 남길 한 줄. 코드가 있으면 앞에 붙여 진단을 빠르게 한다. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = readErrorCode(error);
  return code === undefined ? message : `${code}: ${message}`;
}
