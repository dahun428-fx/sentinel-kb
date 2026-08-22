/**
 * `@sentinel/api` 배럴. HTTP 계약 구현은 specs/04-api.md를 따른다.
 * 생성(`/v1/answer`)·피드백은 후속 태스크에서 채운다.
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/api";
export const DEPENDS_ON = [CORE_PACKAGE] as const;

export { createApp, PAYLOAD_TOO_LARGE_STATUS, type AppOptions } from "./app.js";
export { ApiKeyConfigError, parseApiKeys, resolveProject, PUBLIC_PATHS } from "./auth.js";
export { API_ERROR_CODES, HttpError, type ApiErrorCode } from "./errors.js";
export { decodeCursor, encodeCursor, type ListCursor } from "./cursor.js";
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
  buildSearchLogFields,
  registerSearchRoutes,
  SEARCH_LOG_EVENT,
  SEARCH_ROUTE,
  toSearchHit,
  type BuildSearchLogInput,
  type SearchLogFields,
  type SearchRoutesDeps,
} from "./search.js";
