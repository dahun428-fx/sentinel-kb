/**
 * generator 튜닝 파라미터. 출처: specs/03-rag-pipeline.md §4·§6, .env.example.
 *
 * `retriever/config.ts`와 같은 규약이다 — §6이 "튜닝 파라미터는 **전부** env에서 주입,
 * 코드 하드코딩 금지"라고 못박았으므로 값이 등장하는 자리는 이 파일 하나뿐이고,
 * 파이프라인 코드에는 숫자 리터럴이 없다(`no-hardcoded-params.spec.ts`가 잠근다).
 */

/** `.env.example`과 같은 값. 여기가 유일한 리터럴 등장 지점이다. */
export const GENERATOR_DEFAULTS = {
  /**
   * 생성 게이트 임계값. **척도는 원시 cosine(−1..1)이다** — 0–1 정규화 값이 아니다.
   * retriever가 `2 * normalized - 1`로 이미 환산해서 주므로 **여기서 다시 환산하지 않는다**
   * (T-011 F-A). 한 번 더 접으면 0.62 게이트가 원시 cosine 0.81 게이트가 되어 과하게 조인다.
   */
  SIMILARITY_THRESHOLD: 0.62,
  /**
   * 답변 1건의 출력 상한. 길이는 품질 파라미터라 eval이 흔들 수 있어야 한다.
   * `temperature`가 여기 없는 것은 누락이 아니다 — `llm/types.ts`의 `ChatRequest` 주석 참조.
   */
  ANSWER_MAX_TOKENS: 2048,
} as const;

export type GeneratorEnvName = keyof typeof GENERATOR_DEFAULTS;

export interface GeneratorConfig {
  /** 융합 전 원시 cosine 최고점과 **그대로** 비교되는 값. */
  readonly similarityThreshold: number;
  readonly answerMaxTokens: number;
}

/**
 * env → 설정. 오설정은 던지지 않고 기본값으로 되돌린다(`retriever/config.ts` 선례).
 *
 * **임계값에 `readPositiveInt`를 쓰지 않는다.** 원시 cosine은 소수이고 **음수가 정상값**이며
 * (T-011 F-C), 정수 검사에 걸리면 설정한 값이 조용히 기본값으로 되돌아간다.
 * 대신 유한수이면서 cosine 범위 안일 것만 요구한다 — 범위 밖 임계값은 게이트를
 * 항상-통과 또는 항상-차단으로 만들어 튜닝이 아니라 무력화다.
 */
export function readGeneratorConfig(env: NodeJS.ProcessEnv = process.env): GeneratorConfig {
  return {
    similarityThreshold: readCosine(
      env["SIMILARITY_THRESHOLD"],
      GENERATOR_DEFAULTS.SIMILARITY_THRESHOLD,
    ),
    answerMaxTokens: readPositiveInt(
      env["ANSWER_MAX_TOKENS"],
      GENERATOR_DEFAULTS.ANSWER_MAX_TOKENS,
    ),
  };
}

/** cosine 범위 상한·하한. 튜닝 값이 아니라 cosine의 정의다. */
const COSINE_MIN = -1;
const COSINE_MAX = 1;

function readCosine(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < COSINE_MIN || parsed > COSINE_MAX) return fallback;
  return parsed;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
