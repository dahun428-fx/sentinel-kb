/**
 * retriever 배럴. 출처: specs/03-rag-pipeline.md §2, T-011.
 *
 * mongodb 드라이버를 import하지 않으므로(`types.ts`의 구조적 `RetrievalDbLike` 참조)
 * `@sentinel/core` 메인 배럴에서 re-export해도 web 번들에 드라이버가 끌려오지 않는다.
 * 실제 `Db`는 구조적으로 `RetrievalDbLike`를 만족하므로 호출자가 그대로 넘기면 된다.
 */
export {
  RELATION_EXPANSION_DEFAULT,
  RELATION_EXPANSION_ENV,
  RETRIEVAL_DEFAULTS,
  readRetrievalConfig,
} from "./config.js";
export type { RetrievalConfig, RetrievalEnvName } from "./config.js";
export {
  EXPANDABLE_RELATION_TYPES,
  EXPANDED_SECTIONS,
  MAX_RELATION_CHUNKS,
  RELATION_GRAPH_MAX_DEPTH,
  buildRelationChunkPipeline,
  buildRelationLookupPipeline,
  parseRelationTargets,
  selectExpansionChunks,
} from "./relation-expansion.js";
export type { ExpansionPick, RelationTarget } from "./relation-expansion.js";
export { capByRecordId, dedupeByRecordId, fuseRrf } from "./rrf.js";
export type { FusedEntry, Rankable } from "./rrf.js";
export {
  CHUNKS_COLLECTION,
  RECORDS_COLLECTION,
  RETRIEVER_ERROR_CODES,
  RetrieverError,
  TEXT_INDEX_NAME,
  VECTOR_INDEX_NAME,
  createRetriever,
} from "./retrieve.js";
export type {
  CreateRetrieverOptions,
  RetrieveOptions,
  Retriever,
  RetrieverErrorCode,
} from "./retrieve.js";
export type {
  PathCandidate,
  PipelineStage,
  RelationProvenance,
  RetrievalCollectionLike,
  RetrievalCursorLike,
  RetrievalDbLike,
  RetrievalResult,
  RetrievedChunk,
} from "./types.js";
