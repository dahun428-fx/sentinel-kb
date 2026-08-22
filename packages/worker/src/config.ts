/**
 * 워커 튜닝 파라미터. 출처: specs/03-rag-pipeline.md §1-4·§6, .env.example.
 *
 * §6이 "튜닝 파라미터는 전부 env(.env.example)에서 주입, 코드 하드코딩 금지"라고 못박았다.
 * specs/03 §1-4의 "3회"를 코드 상수로 굳히면 그 규칙을 어긴다(T-003 F-5). 여기 값은
 * env가 없을 때의 **폴백**이며(T-003 `DEFAULT_SERVER_SELECTION_TIMEOUT_MS`와 같은 취급),
 * 실제 운영값은 `.env.example`의 항목이 소스다.
 */

/**
 * 임베딩 잡 재시도 상한. `attempts`가 이 값에 **도달**하면 `dead`로 보낸다.
 * 기본 3 — specs/03 §1-4와 T-008 Acceptance("attempts 증가, 3회 후 dead").
 */
export const DEFAULT_EMBED_JOB_MAX_ATTEMPTS = 3;

/** pending 잡이 없을 때 다음 폴링까지의 대기(ms). */
export const DEFAULT_EMBED_POLL_INTERVAL_MS = 1000;

/**
 * 재시도 백오프 기준(ms). n번째 실패 후 `base * 2^(n-1)`만큼 지나야 다시 클레임된다.
 *
 * 이게 없으면 재시도가 **무의미하다.** 실패 즉시 `pending`으로 돌아가고 그 잡이
 * `createdAt` 최선두라 곧바로 다시 집히므로, **10초짜리 Mongo 순단이나 임베딩 429가
 * 밀리초 안에 attempts를 전부 태워 `dead`로 보낸다.**
 *
 * 새 필드가 필요하지 않다 — `JobSchema`에 이미 `attempts`와 `updatedAt`이 있고
 * `failJob`이 실패 시 `updatedAt`을 갱신하므로, 클레임 필터를
 * `updatedAt < now - backoff(attempts)`로 좁히면 된다. (`.strict()`라 필드 추가는 G3다.)
 */
export const DEFAULT_EMBED_RETRY_BACKOFF_MS = 2000;

export function readEmbedJobMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env["EMBED_JOB_MAX_ATTEMPTS"], DEFAULT_EMBED_JOB_MAX_ATTEMPTS);
}

export function readEmbedPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env["EMBED_POLL_INTERVAL_MS"], DEFAULT_EMBED_POLL_INTERVAL_MS);
}

export function readEmbedRetryBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env["EMBED_RETRY_BACKOFF_MS"], DEFAULT_EMBED_RETRY_BACKOFF_MS);
}

/**
 * `attempts`번 실패한 잡이 다시 클레임되기까지의 최소 경과 시간.
 * attempts 0(첫 시도)이면 0 — 새 잡은 즉시 집힌다.
 */
export function retryDelayMs(attempts: number, baseMs: number): number {
  if (attempts <= 0) return 0;
  return baseMs * 2 ** (attempts - 1);
}

/**
 * 미설정·비수치·0 이하는 폴백으로 떨어진다. 여기서 던지지 않는 이유는 임베딩 설정
 * (`EMBEDDING_DIM` 등)과 성격이 다르기 때문이다 — 재시도 횟수는 모델이 정하는 값이 아니라
 * 운영 취향이라 조용한 기본값이 정합성을 깨지 않는다.
 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
