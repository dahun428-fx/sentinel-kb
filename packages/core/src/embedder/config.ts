/**
 * embedder 설정. 출처: specs/03-rag-pipeline.md §1-3·§6, .env.example, NFR-06.
 *
 * §6이 "튜닝 파라미터는 전부 env에서 주입, 코드 하드코딩 금지"라고 못박았고,
 * NFR-06("임베딩 모델 교체 가능")은 **모델명·차원이 코드에 박히면 성립하지 않는다.**
 * 그래서 `EMBEDDING_MODEL`·`EMBEDDING_DIM`·`EMBEDDING_VERSION`에는 기본값을 두지 않는다 —
 * 없으면 조용히 폴백하지 않고 코드가 붙은 에러로 즉시 실패한다.
 */
import { EMBEDDER_ERROR_CODES, EmbedderError } from "./types.js";

/** 지원 provider. 늘리려면 스펙(T-006 Scope)이 먼저다. */
export const EMBEDDING_PROVIDERS = ["voyage", "fake"] as const;

export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * 한 번의 HTTP 호출에 담는 텍스트 수의 상한이자 기본값. specs/03 §1-3 "임베딩 배치 호출(최대 32개)".
 * `EMBEDDING_BATCH_SIZE`로 낮출 수는 있지만 이 값을 넘길 수는 없다(스펙상 하드 상한).
 */
export const MAX_EMBEDDING_BATCH_SIZE = 32;

export interface EmbedderConfig {
  readonly provider: EmbeddingProvider;
  readonly dim: number;
  readonly version: number;
  readonly batchSize: number;
}

function isProvider(value: string): value is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/** provider 무관 공통 설정. provider별 자격증명은 각 provider 모듈이 읽는다. */
export function readEmbedderConfig(env: NodeJS.ProcessEnv = process.env): EmbedderConfig {
  const rawProvider = env["EMBEDDING_PROVIDER"]?.trim();
  if (!rawProvider || !isProvider(rawProvider)) {
    throw new EmbedderError(
      EMBEDDER_ERROR_CODES.PROVIDER_UNKNOWN,
      `EMBEDDING_PROVIDER가 없거나 지원하지 않는 값이다(받은 값: ${rawProvider ?? "<unset>"}). ` +
        `지원: ${EMBEDDING_PROVIDERS.join(" | ")}`,
    );
  }

  return {
    provider: rawProvider,
    dim: readPositiveInt(
      env["EMBEDDING_DIM"],
      EMBEDDER_ERROR_CODES.DIM_INVALID,
      "EMBEDDING_DIM은 양의 정수여야 한다. 모델이 정하는 값이라 기본값을 두지 않는다(NFR-06).",
    ),
    version: readPositiveInt(
      env["EMBEDDING_VERSION"],
      EMBEDDER_ERROR_CODES.VERSION_INVALID,
      "EMBEDDING_VERSION은 양의 정수여야 한다. 임의 기본값은 청크 버전을 섞는다(specs/02 마이그레이션 규칙).",
    ),
    batchSize: readBatchSize(env["EMBEDDING_BATCH_SIZE"]),
  };
}

function readPositiveInt(
  raw: string | undefined,
  code: (typeof EMBEDDER_ERROR_CODES)["DIM_INVALID" | "VERSION_INVALID"],
  message: string,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) throw new EmbedderError(code, `${message} (받은 값: <unset>)`);
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EmbedderError(code, `${message} (받은 값: ${trimmed})`);
  }
  return parsed;
}

/**
 * 배치 크기는 오설정이 파이프라인을 세우는 것보다 상한으로 눌러 도는 편이 낫다 —
 * 미설정·비수치·0 이하는 기본값, 상한 초과는 상한으로 클램프한다.
 */
function readBatchSize(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return MAX_EMBEDDING_BATCH_SIZE;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return MAX_EMBEDDING_BATCH_SIZE;
  return Math.min(parsed, MAX_EMBEDDING_BATCH_SIZE);
}
