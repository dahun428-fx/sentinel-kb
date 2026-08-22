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

/**
 * 관계 확장(specs/03 §2.5, ADR-07 단계 0)의 on/off 플래그 이름.
 *
 * `RETRIEVAL_DEFAULTS`에 넣지 않는다 — 저 표는 **양의 정수 튜닝 파라미터** 전용이고
 * (`readPositiveInt`가 전부를 훑는다), 이 값은 스윕 대상 숫자가 아니라 **실험 스위치**다.
 */
export const RELATION_EXPANSION_ENV = "RELATION_EXPANSION";

/**
 * **기본값은 off다. 이것이 이 태스크의 핵심 계약이다.**
 *
 * specs/03 §2.5 마지막 문장: "on/off 플래그로 두고 eval에서 효과를 비교한다 —
 * **지표가 오르지 않으면 확장하지 않는다.**" ADR-07 §5도 같은 말을 한다.
 * 즉 확장이 켜져 있어도 된다는 근거는 **측정**이고, 그 측정은 아직 존재하지 않는다
 * (T-013 STATUS: BLOCKED — 임베딩 자격증명이 없어 retrieval eval을 잴 수 없다).
 *
 * 기본을 on으로 두면 "재 보니 좋아서 켰다"와 "안 재고 켰다"가 구별되지 않는다.
 * 이 값을 `true`로 바꾸는 커밋은 **on/off 비교 리포트를 근거로 첨부해야 한다.**
 */
export const RELATION_EXPANSION_DEFAULT = false;

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
  /**
   * 관계 확장(specs/03 §2.5)을 켤 것인가. **기본 false** — 근거는
   * `RELATION_EXPANSION_DEFAULT` 주석. `false`면 retriever는 `$graphLookup`을
   * **아예 발행하지 않는다**(쿼리 1건도 더 나가지 않는다).
   */
  readonly relationExpansion: boolean;
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
    relationExpansion: readFlag(env[RELATION_EXPANSION_ENV], RELATION_EXPANSION_DEFAULT),
  };
}

/**
 * on/off 플래그 해석. 인식하지 못하는 값은 **기본값(off)으로 되돌린다** — 위 파일 주석의
 * 오설정 정책과 같고, 방향도 안전한 쪽이다: 오타 하나로 측정되지 않은 확장이 켜지면 안 된다.
 * (`RELATION_EXPANSION=onn`이 on으로 읽히는 쪽이 훨씬 나쁘다.)
 */
function readFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (value === "on" || value === "true" || value === "1" || value === "yes") return true;
  if (value === "off" || value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
