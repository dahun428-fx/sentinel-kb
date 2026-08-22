/**
 * retriever 튜닝 파라미터. 출처: specs/03-rag-pipeline.md §2·§6, .env.example.
 *
 * §6이 "튜닝 파라미터는 **전부** env에서 주입, 코드 하드코딩 금지"라고 못박은 이유는
 * eval(T-013)에서 이 값들을 스윕하기 위함이다. 그래서 값이 등장하는 자리는 이 파일 하나뿐이고,
 * `retrieve.ts`의 파이프라인 코드에는 숫자 리터럴이 없다 (`no-hardcoded-params.spec.ts`가 잠근다).
 *
 * **오설정 정책은 `SEARCH_INDEX_*`(T-010)·`EMBEDDING_BATCH_SIZE`(T-006) 선례를 따른다** —
 * 양의 정수가 아니면 던지지 않고 기본값으로 되돌린다. 검색은 오설정 때문에 서비스를
 * 세우는 것보다 스펙 기본값으로 도는 편이 낫다. (`EMBEDDING_DIM`류가 기본값을 갖지 않는 것과
 * 대비된다 — 그쪽은 모델이 정하는 값이라 임의 기본값이 데이터를 오염시킨다.)
 */

/**
 * `.env.example`과 같은 값. 여기가 유일한 리터럴 등장 지점이다.
 * 키는 env 이름 그대로 둔다 — grep 테스트가 이 표와 `.env.example`을 직접 대조한다.
 */
export const RETRIEVAL_DEFAULTS = {
  RETRIEVAL_VECTOR_K: 20,
  RETRIEVAL_TEXT_K: 20,
  RETRIEVAL_FINAL_K: 8,
  RRF_K: 60,
  RETRIEVAL_NUM_CANDIDATES: 200,
  RETRIEVAL_CANDIDATE_OVERFETCH: 4,
  RETRIEVAL_MAX_CHUNKS_PER_RECORD: 2,
} as const;

export type RetrievalEnvName = keyof typeof RETRIEVAL_DEFAULTS;

export interface RetrievalConfig {
  /** `$vectorSearch` 경로가 융합에 넘기는 후보 수. */
  readonly vectorK: number;
  /** `$search` 경로가 융합에 넘기는 후보 수. */
  readonly textK: number;
  /** dedupe 후 최종 반환 수. */
  readonly finalK: number;
  /** RRF 감쇠 상수. `score = Σ 1/(k + rank)`. */
  readonly rrfK: number;
  /** `$vectorSearch`의 ANN 탐색 폭. */
  readonly numCandidates: number;
  /**
   * 후보를 K의 몇 배로 긁어올지. T-005 F-3 대응 — 28청크짜리 레코드 하나가
   * K 슬롯을 통째로 먹는 것을 막으려면 recordId 상한을 걸 **여유분**이 필요하다.
   */
  readonly candidateOverfetch: number;
  /** record당 최대 청크 수. 후보 단계와 융합 후 dedupe에 **같은 값**이 쓰인다. */
  readonly maxChunksPerRecord: number;
}

/**
 * env → 설정. 미설정·비수치·0 이하는 전부 기본값으로 되돌린다.
 */
export function readRetrievalConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const read = (name: RetrievalEnvName): number =>
    readPositiveInt(env[name], RETRIEVAL_DEFAULTS[name]);

  const vectorK = read("RETRIEVAL_VECTOR_K");
  const candidateOverfetch = read("RETRIEVAL_CANDIDATE_OVERFETCH");

  return {
    vectorK,
    textK: read("RETRIEVAL_TEXT_K"),
    finalK: read("RETRIEVAL_FINAL_K"),
    rrfK: read("RRF_K"),
    /*
     * Atlas는 `numCandidates >= limit`를 요구한다. overfetch를 키운 채 numCandidates를
     * 그대로 두면 쿼리가 통째로 죽으므로, 오설정을 여기서 흡수한다.
     */
    numCandidates: Math.max(read("RETRIEVAL_NUM_CANDIDATES"), vectorK * candidateOverfetch),
    candidateOverfetch,
    maxChunksPerRecord: read("RETRIEVAL_MAX_CHUNKS_PER_RECORD"),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
