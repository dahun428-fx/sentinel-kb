/**
 * HTTP 에러 응답. 출처: specs/04-api.md 규약
 * > 에러: `{error:{code, message, details?}}`, code는 SCREAMING_SNAKE.
 *
 * 형상을 여기서 다시 정의하지 않는다 — contracts의 `ApiError`가 단일 소스이고,
 * 이 모듈은 그것을 **실제로 파싱해서** 내보낸다. 파싱을 끼워 넣는 이유는 code 표기법이
 * 조용히 어긋나는 것을 막기 위함이다(`ApiError`의 정규식이 SCREAMING_SNAKE를 강제한다).
 * 케이스가 섞이면 클라이언트의 에러 분기가 소리 없이 깨진다.
 */
import { ApiError } from "@sentinel/contracts";
import type { FastifyReply } from "fastify";

/**
 * 이 API가 내는 에러 코드 전부. 문자열 리터럴을 라우터에 흩뿌리지 않는다 —
 * 오타 하나가 클라이언트 분기를 깨는데 타입 검사가 잡아 주지 않기 때문이다.
 */
export const API_ERROR_CODES = {
  /** 인증 헤더 없음/형식 오류/미등록 키. 어느 쪽인지는 **구분해 알리지 않는다.** */
  UNAUTHORIZED: "UNAUTHORIZED",
  /**
   * 바디에 `project`가 왔다. specs/04가 "조용히 무시"를 "400 거부"로 고친 그 케이스다 —
   * 무시하면 클라이언트가 B에 썼다고 믿는데 A에 저장되는 confused deputy가 된다.
   */
  PROJECT_NOT_ALLOWED_IN_BODY: "PROJECT_NOT_ALLOWED_IN_BODY",
  /** 레코드 종류는 바꿀 수 없다. `PatchRecordInput`이 이미 막지만 서버에서도 확인한다. */
  TYPE_IMMUTABLE: "TYPE_IMMUTABLE",
  /** Zod 스키마 위반 일반. `details`에 issue 목록을 싣는다. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** incident에 `expected`처럼 다른 종류의 필드를 PATCH했다 (T-002 F-2). */
  FIELD_NOT_ALLOWED_FOR_TYPE: "FIELD_NOT_ALLOWED_FOR_TYPE",
  /** 새니타이즈 입력 길이 상한 초과. core의 `SanitizeInputTooLargeError.code`와 같은 값이다. */
  SANITIZE_INPUT_TOO_LARGE: "SANITIZE_INPUT_TOO_LARGE",
  /** 새니타이즈 결과가 `RecordSchema`를 벗어났다(예: 마스킹 라벨이 제목을 200자 너머로 밀었다). */
  SANITIZED_RECORD_INVALID: "SANITIZED_RECORD_INVALID",
  /** cursor가 이 서버가 발급한 형식이 아니다. */
  INVALID_CURSOR: "INVALID_CURSOR",
  RECORD_NOT_FOUND: "RECORD_NOT_FOUND",
  /** specs/04: `project` 크로스 **조회**는 허용, **쓰기는 자기 project로만**. */
  CROSS_PROJECT_WRITE_FORBIDDEN: "CROSS_PROJECT_WRITE_FORBIDDEN",
  ARTICLE_NOT_FOUND: "ARTICLE_NOT_FOUND",
  /**
   * 바디에 `publishedAt`이 왔다 (B-1).
   *
   * `PatchArticleInput`·`PublishArticleInput`의 `.strict()`가 어차피 거부하지만, 그 메시지는
   * "Unrecognized key(s)"라 **무엇이 왜 문제인지** 말하지 않는다. 이 값은 specs/04 블록쿼트가
   * "배치가 세 겹으로 막은 자동 발행 금지가 HTTP 표면에서 뚫린다"고 지목한 바로 그 필드이므로,
   * 거부 사유도 그만큼 명시적이어야 한다 — `PROJECT_NOT_ALLOWED_IN_BODY`와 같은 축이다.
   */
  PUBLISHED_AT_IS_SERVER_OWNED: "PUBLISHED_AT_IS_SERVER_OWNED",
  /** specs/04: 편집은 `candidate`·`draft`에서만 허용. 발행·반려된 글은 대상이 아니다. */
  ARTICLE_NOT_EDITABLE: "ARTICLE_NOT_EDITABLE",
  /** 발행 대상이 `draft`가 아니거나 본문이 없다 (specs/08 §0-5·§7). */
  ARTICLE_NOT_PUBLISHABLE: "ARTICLE_NOT_PUBLISHABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/**
 * 라우터가 던지는 에러. 핸들러마다 `reply.code(...).send(...)`를 반복하는 대신
 * 던지고 한곳에서 번역한다 — 응답 형상이 갈라질 자리를 없앤다.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** `{error:{code, message, details?}}`를 만들어 contracts 스키마로 검증한 뒤 돌려준다. */
export function toErrorBody(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return ApiError.parse({
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(statusCode).send(toErrorBody(code, message, details));
}
