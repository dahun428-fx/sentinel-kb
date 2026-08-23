/**
 * `@sentinel/worker` 배럴 — 임베딩 잡 소비자 (T-008).
 * 프로세스 진입점은 `worker.cli.ts`이며, 여기서 re-export하지 않는다(import만으로 워커가 뜨면 안 된다).
 */
import { PACKAGE_NAME as CORE_PACKAGE } from "@sentinel/core";

export const PACKAGE_NAME = "@sentinel/worker";
export const DEPENDS_ON = [CORE_PACKAGE] as const;

export {
  DEFAULT_EMBED_JOB_MAX_ATTEMPTS,
  DEFAULT_EMBED_POLL_INTERVAL_MS,
  readEmbedJobMaxAttempts,
  readEmbedPollIntervalMs,
} from "./config.js";
export { WORKER_ERROR_CODES, WorkerError, isPermanentFailure } from "./errors.js";
export type { WorkerErrorCode } from "./errors.js";
export { claimNextJob, completeJob, failJob } from "./jobs.js";
export type { JobDocument, JobFailure } from "./jobs.js";
export { ingestRecord } from "./ingest.js";
export type { ChunkDocument, IngestResult } from "./ingest.js";
export { createEmbedWorker } from "./worker.js";
export type { EmbedWorker, EmbedWorkerDeps, JobOutcome } from "./worker.js";

// 아티클 트리거 배치 (T-029, specs/08 §1·§2).
// `articlesCollection`·`ArticleDocument`는 B-1에서 `@sentinel/core/db`로 올라갔다.
// 여기서 re-export하지 않는다 — 경유지라도 출처가 둘로 보인다(T-037 판단).
export { articleId, articleSlug, slugifyLabel } from "./articles.js";
export {
  DEFAULT_ARTICLE_TRIGGER_THRESHOLDS,
  evaluateArticleTriggers,
  isArticleMaterial,
  lastCompleteWeek,
} from "./article-triggers.js";
export type {
  ArticleCandidate,
  ArticleTriggerThresholds,
  EvaluateTriggersOptions,
  TriggerRecord,
} from "./article-triggers.js";
export { runArticleTriggerBatch } from "./article-batch.js";
export type { ArticleBatchDeps, ArticleBatchResult } from "./article-batch.js";
