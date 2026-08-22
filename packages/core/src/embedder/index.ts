/**
 * embedder 서브모듈 배럴 + env 팩토리. 출처: T-006 Scope("provider 1종 구현 + env 기반 팩토리").
 *
 * DB 드라이버를 끌고 오지 않으므로 `@sentinel/core` 메인 배럴에서 re-export해도 안전하다.
 * 워커 통합(T-008)은 이 팩토리만 부르면 되고, provider 선택을 직접 알 필요가 없다.
 */
import { readEmbedderConfig } from "./config.js";
import { createFakeEmbedder } from "./fake.js";
import { createVoyageEmbedder, readVoyageCredentials } from "./voyage.js";
import type { Embedder, FetchLike, SleepFn } from "./types.js";

export {
  MAX_EMBEDDING_BATCH_SIZE,
  EMBEDDING_PROVIDERS,
  readEmbedderConfig,
  readEmbeddingDim,
} from "./config.js";
export type { EmbedderConfig, EmbeddingProvider } from "./config.js";
export { createFakeEmbedder, deterministicVector } from "./fake.js";
export type { FakeEmbedderOptions } from "./fake.js";
export { EMBEDDER_ERROR_CODES, EmbedderError, realSleep } from "./types.js";
export type { Embedder, EmbedderErrorCode, FetchLike, HttpResponseLike, SleepFn } from "./types.js";
export { createVoyageEmbedder, readVoyageCredentials } from "./voyage.js";
export type { VoyageCredentials, VoyageEmbedderOptions } from "./voyage.js";

export interface CreateEmbedderOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** 테스트가 HTTP를 대체하는 지점. provider가 `fake`면 무시된다. */
  readonly fetch?: FetchLike;
  /** 테스트가 백오프 대기를 즉시 resolve로 바꾸는 지점. */
  readonly sleep?: SleepFn;
}

/**
 * `EMBEDDING_PROVIDER`로 구현체를 고른다. 설정이 잘못됐으면 **여기서** `EmbedderError`로
 * 실패한다 — 임베딩 잡이 처음 도는 순간까지 오설정을 숨기지 않는다.
 */
export function createEmbedder(options: CreateEmbedderOptions = {}): Embedder {
  const env = options.env ?? process.env;
  const { provider, dim, version, batchSize } = readEmbedderConfig(env);

  if (provider === "fake") {
    return createFakeEmbedder({ dim, version });
  }

  const { model, apiKey } = readVoyageCredentials(env);
  return createVoyageEmbedder({
    model,
    apiKey,
    dim,
    version,
    batchSize,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}
