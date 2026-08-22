/**
 * retriever 타입. 출처: specs/03-rag-pipeline.md §2·§4, specs/02-data-model.md §인덱스.
 *
 * ## 왜 `SearchHit`(contracts)을 돌려주지 않는가
 *
 * `SearchHit`은 `.strict()`이고 `{recordId,title,summary,section,score,type,project,flags}`뿐이다.
 * retriever의 출력은 **두 소비자**를 갖는다:
 *  - T-012(`POST /v1/search`)는 `SearchHit`으로 투영하면 되지만,
 *  - T-018(generate)은 **청크 본문**과 융합 전 cosine 점수가 필요하다. `summary`(레코드 요약)로는
 *    답을 만들 수 없고 인용 `[REC-{id}#{section}]`도 만들 수 없다.
 *
 * `SearchHit`을 그대로 돌려주면 T-018이 청크를 다시 조회해야 하고(같은 검색을 두 번),
 * `SearchHit`을 넓히면 HTTP 응답에 본문이 실려 NFR-03(토큰 예산)을 위반한다.
 * 그래서 core는 **도메인 타입**을 돌려주고 HTTP 모양으로의 투영은 경계(T-012)가 한다 —
 * CLAUDE.md "core는 HTTP/MCP를 모른다"와 "API 계약은 contracts가 단일 소스"를 둘 다 지킨다.
 * (`Embedder`·`EmbedderConfig`가 core에 사는 것과 같은 근거. `embedder/types.ts` 참조.)
 *
 * `section`·`type`은 contracts의 열거형을 **재정의하지 않고 그대로 재사용**한다.
 */
import type { ChunkSection, RecordType, SanitizeFlag } from "@sentinel/contracts";

/**
 * 이 모듈이 실제로 쓰는 드라이버 표면만 추린 구조적 타입.
 * `Db`/`Collection`을 import하면 retriever가 mongodb를 module graph로 끌고 들어와
 * `@sentinel/core` 메인 배럴에서 re-export할 수 없게 된다(`db/index.ts`의 그 이유).
 * 동시에 단위 테스트가 파이프라인 자체를 컨테이너 없이 검사할 수 있게 된다
 * (`search-indexes.ts`의 `SearchIndexDbLike`와 같은 선례).
 */
export type PipelineStage = Record<string, unknown>;

export interface RetrievalCursorLike {
  toArray(): Promise<Record<string, unknown>[]>;
}

export interface RetrievalCollectionLike {
  aggregate(pipeline: PipelineStage[]): RetrievalCursorLike;
}

/**
 * **불변식: `$vectorSearch`·`$search`는 결과를 점수 내림차순으로 돌려준다.**
 * `retrieve.ts`가 `maxVectorScore`를 후보 상한 **전에** 계산하는 위치의 정당성과,
 * RRF가 배열 인덱스를 그대로 순위로 쓰는 것이 둘 다 이 순서에 걸려 있다.
 * 이 순서가 깨지면 그 계산 위치의 정당성이 사라지고 값이 조용히 갈린다.
 * 구조적 타입이라 타입으로 강제할 수 없으므로 계약으로 적어 둔다 —
 * 이 인터페이스를 fake로 구현하는 테스트도 이 순서를 지켜야 한다.
 */
export interface RetrievalDbLike {
  collection(name: string): RetrievalCollectionLike;
}

/** 한쪽 경로가 돌려준 후보 1건. 융합 전 원시 점수를 그대로 들고 있다. */
export interface PathCandidate {
  readonly chunkId: string;
  readonly recordId: string;
  /**
   * 드라이버가 준 원본 `recordId` 값(대개 `ObjectId`). records 조회의 `$in`에 그대로 쓴다 —
   * hex 문자열을 다시 `ObjectId`로 만들려면 bson을 import해야 하는데, 그러면 위의
   * "mongodb 미의존" 결정이 무너진다.
   */
  readonly recordIdRaw: unknown;
  readonly section: ChunkSection;
  readonly seq: number;
  readonly text: string;
  readonly type: RecordType;
  readonly project: string;
  /**
   * 청크의 `meta.sanitizeFlags`. `injection-suspect` 청크는 **결과에서 빼지 않는다** —
   * specs/03 §2가 "생성 컨텍스트에서 제외, 목록에는 경고와 함께 노출"이라고 갈라놓았고,
   * 검색 결과 목록은 후자다. 제외 판단은 T-018이 이 플래그를 보고 한다.
   */
  readonly flags: SanitizeFlag[];
  /**
   * vector 경로면 **원시 cosine(−1..1)**, text 경로면 `searchScore`(BM25, 무제한).
   * vector 쪽은 Atlas가 준 `vectorSearchScore`를 그대로 담지 않는다 — Atlas는
   * `(1 + cos) / 2`로 정규화한 0–1 값을 주고, `retrieve.ts`의 `toRawCosine`이 되돌린다.
   * BM25는 cosine이 아니므로 환산 대상이 아니다.
   */
  readonly score: number;
}

/** 최종 결과 1건. 청크 수준이며 record 메타(title/summary)가 붙어 있다. */
export interface RetrievedChunk {
  readonly chunkId: string;
  readonly recordId: string;
  readonly section: ChunkSection;
  readonly seq: number;
  /** 청크 본문. T-018이 생성 컨텍스트로 쓴다. HTTP 응답에는 싣지 않는다(NFR-03). */
  readonly text: string;
  readonly title: string;
  /** record의 요약. `SearchHit.summary`로 그대로 간다 — 본문이 아니다. */
  readonly summary: string;
  readonly type: RecordType;
  readonly project: string;
  readonly flags: SanitizeFlag[];
  /** RRF 점수. **순위 결정 전용**. */
  readonly fusedScore: number;
  /**
   * 이 청크의 **원시 cosine(−1..1)**. 텍스트 경로에서만 왔으면 null.
   * `maxVectorScore`와 **같은 척도**다 — 둘 다 `toRawCosine`을 거친 같은 배열에서 온다.
   */
  readonly vectorScore: number | null;
  /** BM25 `searchScore`(무제한). **cosine이 아니므로 환산하지 않는다.** */
  readonly textScore: number | null;
  readonly vectorRank: number | null;
  readonly textRank: number | null;
}

/**
 * retrieve 1회의 결과.
 *
 * ## `maxVectorScore`를 hit마다가 아니라 여기 둔 이유 (감사 B-1)
 *
 * specs/03 §4는 "**벡터 검색의 원시 cosine 최고점**이 `SIMILARITY_THRESHOLD` 미만이면
 * 생성을 스킵"이라고 쓴다. 판정 대상은 **질의 1건**이지 hit 1건이 아니다.
 *
 *  - hit별로만 두면 T-018이 스스로 max를 접어야 하고, 텍스트 경로에서만 온 hit은
 *    cosine이 아예 없어(null) 그 축약을 매번 틀리게 짤 여지가 생긴다.
 *  - 더 결정적으로, hit별 값은 **dedupe·slice를 살아남은** 청크의 것뿐이다. 최고점 청크가
 *    record당 상한에 걸려 잘렸다면 hit별 max는 실제 최고점보다 낮고, 게이트가 스펙보다
 *    엄격해져 조용히 `found:false`가 는다.
 *
 * 그래서 이 값은 **융합·dedupe·slice 이전**의 원시 벡터 후보 전체에 대한 최고점이다.
 * 벡터 경로가 0건이면 null이다 — 0이 아니다. "0점"과 "판정 불가"는 다르다.
 * (hit별 `vectorScore`는 진단·eval용으로 별도로 남아 있다.)
 *
 * ## 척도: 원시 cosine **−1..1**이다 (0–1이 아니다)
 *
 * Atlas가 준 `vectorSearchScore`는 `(1 + cos) / 2`로 정규화된 0–1 값이고,
 * `retrieve.ts`의 `toRawCosine`이 원시 cosine으로 되돌린 뒤 이 값이 만들어진다.
 * 따라서 **음수가 정상값이다** — 질의와 반대 방향인 후보뿐이면 −1에 가까워진다.
 * `null`(벡터 경로 0건)과 음수는 **다른 것**이다: 전자는 판정 불가, 후자는 "아주 안 맞음"이다.
 * T-018의 `SIMILARITY_THRESHOLD` 게이트는 이 둘을 갈라서 다뤄야 한다.
 */
export interface RetrievalResult {
  readonly hits: RetrievedChunk[];
  readonly maxVectorScore: number | null;
  /** 융합 전, 상한 적용 전 후보 수. 어느 경로가 기여했는지 판정하는 근거(Acceptance 3). */
  readonly vectorCandidateCount: number;
  readonly textCandidateCount: number;
}
