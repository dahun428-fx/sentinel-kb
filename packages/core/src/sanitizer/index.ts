/**
 * `sanitizer` — 저장 경로의 동기 게이트 (specs/00 FR-06, T-004).
 * 정규식 전용·무상태·결정론. 외부 I/O 없음.
 */
export * from "./sanitize.js";
export * from "./masking.js";
export { detectInjection, toProbe, ZERO_WIDTH_THRESHOLD } from "./injection.js";
export {
  detectStructural,
  hasMixedScriptWord,
  EMITTED_CONTAINER_TAGS,
  KNOWN_STRUCTURAL_GAPS,
} from "./structural.js";
