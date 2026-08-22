/**
 * chunker 서브모듈 배럴. 인제스트 워커(T-008)와 eval이 여기서 가져간다.
 * DB 드라이버를 끌고 오지 않으므로 `@sentinel/core` 메인 배럴에서 re-export해도 안전하다.
 */
export { ChunkBudgetError, chunkRecord } from "./chunk-record.js";
export type { ChunkOptions, SectionChunk } from "./chunk-record.js";
export { DEFAULT_CHUNK_MAX_CHARS, readChunkMaxChars } from "./config.js";
