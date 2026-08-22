/**
 * `@sentinel/api` 배럴. HTTP 계약 구현은 specs/04-api.md를 따른다.
 * specs/04 표의 오퍼레이션 8개가 모두 라우트로 섰다(`/v1/answer`는 T-019).
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/api";
export const DEPENDS_ON = [CORE_PACKAGE] as const;

export { createApp, PAYLOAD_TOO_LARGE_STATUS, type AppOptions } from "./app.js";
// `parseApiKeys`·`ApiKeyConfigError`는 T-037에서 `@sentinel/core`로 올라갔다.
// 여기서 re-export하지 않는다 — 사본이 아니라 **경유지**라도 두 개의 출처처럼 보이고,
// 소비자(`scripts/seed.cli.ts`)가 core를 직접 부르는 편이 의존 방향을 그대로 드러낸다.
export { resolveProject, PUBLIC_PATHS } from "./auth.js";
export { API_ERROR_CODES, HttpError, type ApiErrorCode } from "./errors.js";
export {
  diffOperations,
  documentedOperations,
  normalizePath,
  OPENAPI_ROUTE,
  PENDING_OPERATIONS,
  registerOpenApiRoute,
  routeKey,
  trackRoutes,
  UNDOCUMENTED_ROUTES,
  type DiffOptions,
  type DriftReport,
  type PendingOperation,
  type RouteRef,
} from "./openapi.js";
export { decodeCursor, encodeCursor, type ListCursor } from "./cursor.js";
// 골든셋의 **정의**(승인된 케이스만)와 그 컬렉션 핸들. eval 러너(T-013)가 소비한다 —
// 같은 필터를 러너 쪽에 다시 적으면 "골든셋" 정의가 둘이 되고, `/v1/feedback`이 만드는
// 미승인 후보가 언젠가 한쪽으로만 새어 들어온다 (specs/02: 사람 승인 없이 자동 추가 금지).
export {
  APPROVED_EVAL_CASE_FILTER,
  EVAL_CASE_CANDIDATE_FILTER,
  evalCasesCollection,
  type EvalCaseDocument,
} from "./feedback.js";
export {
  buildSummary,
  firstSentences,
  SUMMARY_MAX_CHARS,
  SUMMARY_SENTENCE_COUNT,
} from "./summary.js";
export {
  sanitizeFields,
  toSanitizeWarning,
  type SanitizedFields,
  type SanitizeWarning,
} from "./sanitize-record.js";
export {
  allowedPatchFields,
  BODY_SECTION_FIELDS,
  isBodySectionField,
  summarySourceField,
} from "./record-fields.js";
export {
  ANSWER_CHUNK_CHARS,
  ANSWER_LOG_EVENT,
  ANSWER_ROUTE,
  buildAnswerLogFields,
  registerAnswerRoutes,
  splitAnswerChunks,
  sseFrame,
  toAnswerBody,
  SSE_CONTENT_TYPE,
  SSE_EVENTS,
  toCitation,
  toCitations,
  type AnswerLogFields,
  type AnswerRoutesDeps,
  type BuildAnswerLogInput,
} from "./answer.js";
export {
  buildSearchLogFields,
  registerSearchRoutes,
  SEARCH_LOG_EVENT,
  SEARCH_ROUTE,
  toSearchHit,
  type BuildSearchLogInput,
  type SearchLogFields,
  type SearchRoutesDeps,
} from "./search.js";
