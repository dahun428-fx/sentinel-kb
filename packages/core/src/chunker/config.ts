/**
 * chunker 튜닝 파라미터. 출처: specs/03-rag-pipeline.md §1-2, §6.
 *
 * §6이 "튜닝 파라미터는 전부 env(.env.example)에서 주입, 코드 하드코딩 금지"라고
 * 못박은 이유는 eval에서 값을 스윕하기 위함이다. 여기 있는 기본값은 env가 없을 때의
 * 폴백이며(T-003 `DEFAULT_SERVER_SELECTION_TIMEOUT_MS`와 같은 취급), 실제 운영값은
 * `.env.example`의 `CHUNK_MAX_CHARS`가 소스다.
 */

/** 청크 1개의 최대 문자 수. specs/03 §1-2가 명시한 1200자. prefix 길이를 포함한 총량이다. */
export const DEFAULT_CHUNK_MAX_CHARS = 1200;

/**
 * `CHUNK_MAX_CHARS`를 읽는다. 미설정·비수치·0 이하는 기본값으로 떨어진다 —
 * 오설정 하나가 청크를 1글자씩 쪼개 임베딩 비용을 폭발시키는 것보다 낫다.
 */
export function readChunkMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["CHUNK_MAX_CHARS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHUNK_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_CHUNK_MAX_CHARS;
  return parsed;
}
