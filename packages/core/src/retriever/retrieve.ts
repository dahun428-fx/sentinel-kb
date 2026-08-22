/**
 * 하이브리드 검색: `$vectorSearch` + `$search` → RRF 융합 → dedupeByRecordId → Top-N.
 * 출처: specs/03-rag-pipeline.md §2, specs/02-data-model.md §인덱스.
 *
 * 숫자 리터럴은 이 파일에 없다 — 전부 `config.ts`(env)에서 온다 (specs/03 §6).
 */
import { ChunkSection, RecordType, SanitizeFlag } from "@sentinel/contracts";

import { readRetrievalConfig, type RetrievalConfig } from "./config.js";
import {
  buildRelationChunkPipeline,
  buildRelationLookupPipeline,
  MAX_RELATION_CHUNKS,
  parseRelationTargets,
  selectExpansionChunks,
  type ExpansionPick,
} from "./relation-expansion.js";
import { capByRecordId, dedupeByRecordId, fuseRrf } from "./rrf.js";
import type {
  PathCandidate,
  PipelineStage,
  RetrievalDbLike,
  RetrievalResult,
  RetrievedChunk,
} from "./types.js";
import type { Embedder } from "../embedder/types.js";

/**
 * specs/02 §인덱스가 정한 이름. 튜닝 파라미터가 아니라 **스키마 식별자**라 env로 빼지 않는다
 * (인덱스를 만드는 쪽인 `db/search-indexes/*.json`도 파일명으로 이 이름을 고정한다).
 * 두 곳이 갈라지면 쿼리가 조용히 0건이 되므로 `retrieve.spec.ts`가 정의 파일과 대조한다.
 */
export const VECTOR_INDEX_NAME = "vec_idx";
export const TEXT_INDEX_NAME = "text_idx";
export const CHUNKS_COLLECTION = "chunks";
export const RECORDS_COLLECTION = "records";

export const RETRIEVER_ERROR_CODES = {
  /** 쿼리가 비었다 — 임베딩도 텍스트 검색도 의미가 없다. */
  QUERY_EMPTY: "RETRIEVER_QUERY_EMPTY",
  /** embedder가 벡터를 1개 돌려주지 않았거나 차원이 `embedder.dim`과 다르다. */
  QUERY_VECTOR_INVALID: "RETRIEVER_QUERY_VECTOR_INVALID",
  /** 검색 결과 도큐먼트가 chunks 스키마와 다르다 — 인제스트 쪽 데이터 무결성 문제다. */
  CANDIDATE_INVALID: "RETRIEVER_CANDIDATE_INVALID",
} as const;

export type RetrieverErrorCode =
  (typeof RETRIEVER_ERROR_CODES)[keyof typeof RETRIEVER_ERROR_CODES];

export class RetrieverError extends Error {
  readonly code: RetrieverErrorCode;

  constructor(code: RetrieverErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RetrieverError";
    this.code = code;
  }
}

export interface CreateRetrieverOptions {
  readonly db: RetrievalDbLike;
  readonly embedder: Embedder;
  /** 생략하면 `process.env`에서 읽는다. 테스트·eval 스윕이 주입하는 지점이다. */
  readonly config?: RetrievalConfig;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RetrieveOptions {
  readonly query: string;
  /** `meta.type` 필터. `vec_idx`가 filter로 선언한 3종 중 하나다. */
  readonly type?: RecordType;
  /** `meta.project` 필터. */
  readonly project?: string;
  /** 최종 반환 수. 생략하면 `RETRIEVAL_FINAL_K`. */
  readonly limit?: number;
}

export interface Retriever {
  retrieve(options: RetrieveOptions): Promise<RetrievalResult>;
  readonly config: RetrievalConfig;
}

export function createRetriever(options: CreateRetrieverOptions): Retriever {
  const config = options.config ?? readRetrievalConfig(options.env);
  const { db, embedder } = options;

  return {
    config,
    async retrieve(request: RetrieveOptions): Promise<RetrievalResult> {
      const query = request.query.trim();
      if (query.length === 0) {
        throw new RetrieverError(
          RETRIEVER_ERROR_CODES.QUERY_EMPTY,
          "검색 쿼리가 비어 있다. 빈 쿼리는 $search를 전체 스캔으로 만들고 임베딩도 무의미하다.",
        );
      }

      const queryVector = await embedQuery(embedder, query);
      const chunks = db.collection(CHUNKS_COLLECTION);

      /*
       * 두 경로는 서로를 기다릴 이유가 없다. 순차로 돌리면 지연이 그대로 더해진다.
       * 한쪽이 던지면 전체가 던진다 — 검색 인덱스 드리프트(T-010 F-7)는 조용히
       * 반쪽 결과로 퇴화하는 것보다 시끄럽게 죽는 편이 낫다.
       */
      const [vectorDocs, textDocs] = await Promise.all([
        chunks.aggregate(buildVectorPipeline(queryVector, request, config, embedder.version)).toArray(),
        chunks.aggregate(buildTextPipeline(query, request, config, embedder.version)).toArray(),
      ]);

      const vectorRaw = vectorDocs.map((doc) => parseCandidate(doc, "vector"));
      const textRaw = textDocs.map((doc) => parseCandidate(doc, "text"));

      /*
       * 감사 B-1: 게이트가 쓰는 값은 **융합·상한·dedupe 이전**의 원시 cosine 최고점이다.
       * 아래 어느 단계도 이 값을 바꾸지 못하도록 여기서 먼저 접는다.
       * `vectorRaw[].score`는 `parseCandidate`가 이미 `toRawCosine`으로 환산한 값이라
       * 여기서 다시 곱하지 않는다 — 환산 지점은 그 한 곳뿐이다(hit별 `vectorScore`도 같은 배열에서 온다).
       */
      const maxVectorScore =
        vectorRaw.length === 0 ? null : Math.max(...vectorRaw.map((c) => c.score));

      // T-005 F-3: 후보 단계에서 recordId 상한을 걸어 장문 레코드의 슬롯 독점을 막는다.
      const vector = capByRecordId(vectorRaw, config.maxChunksPerRecord, config.vectorK);
      const text = capByRecordId(textRaw, config.maxChunksPerRecord, config.textK);

      const fused = fuseRrf(vector, text, config.rrfK);
      const limit = request.limit ?? config.finalK;
      const top = dedupeByRecordId(
        fused.map((entry) => ({ ...entry, recordId: entry.candidate.recordId })),
        config.maxChunksPerRecord,
      ).slice(0, limit);

      const textScoreByChunk = new Map(textRaw.map((c) => [c.chunkId, c.score]));
      const vectorScoreByChunk = new Map(vectorRaw.map((c) => [c.chunkId, c.score]));

      /*
       * 관계 확장 (specs/03 §2.5). **`maxVectorScore`가 이미 확정된 뒤**에 일어난다 —
       * 확장 청크에는 cosine이 없으므로 게이트(T-018)의 판정 대상이 될 수 없고,
       * 여기서 순서를 뒤집으면 "관계를 타고 온 청크 때문에 게이트가 열렸다"는 상태가 생긴다.
       * 플래그가 off면 쿼리 자체가 나가지 않는다(Acceptance 2).
       */
      const expansion = config.relationExpansion
        ? await expandByRelations(db, top.map((entry) => entry.candidate), embedder.version)
        : [];

      const records = await loadRecordMeta(db, [
        ...top.map((entry) => entry.candidate),
        ...expansion.map((pick) => pick.candidate),
      ]);

      const hits: RetrievedChunk[] = [];
      for (const entry of top) {
        const meta = records.get(entry.candidate.recordId);
        // record가 사라진 고아 청크는 인용할 수 없다 — 제목도 요약도 만들 수 없으므로 뺀다.
        if (meta === undefined) continue;
        hits.push({
          chunkId: entry.candidate.chunkId,
          recordId: entry.candidate.recordId,
          section: entry.candidate.section,
          seq: entry.candidate.seq,
          text: entry.candidate.text,
          title: meta.title,
          summary: meta.summary,
          type: entry.candidate.type,
          project: entry.candidate.project,
          flags: entry.candidate.flags,
          fusedScore: entry.score,
          vectorScore: vectorScoreByChunk.get(entry.candidate.chunkId) ?? null,
          textScore: textScoreByChunk.get(entry.candidate.chunkId) ?? null,
          vectorRank: entry.vectorRank,
          textRank: entry.textRank,
          relation: null,
        });
      }

      /*
       * 확장 청크는 **검색 hit 뒤에** 붙는다. 질의가 직접 찾은 근거가 먼저이고 관계로
       * 딸려 온 근거가 나중이다 — 순서를 섞으면 RRF 순위가 의미를 잃는다.
       * `injection-suspect`는 여기서 걸러내지 **않는다**: specs/03 §2가 "생성 컨텍스트에서
       * 제외(목록에는 경고와 함께 노출)"로 소비자를 갈라 놨고, 제외는 전적으로
       * `generator/context.ts`의 의무다(그 파일 주석 참조). 확장 청크만 여기서 미리 빼면
       * 제외 지점이 두 곳이 되어 갈라지고, 목록에서 경고와 함께 보여야 할 것이 사라진다.
       */
      for (const pick of expansion) {
        const meta = records.get(pick.candidate.recordId);
        if (meta === undefined) continue;
        hits.push({
          chunkId: pick.candidate.chunkId,
          recordId: pick.candidate.recordId,
          section: pick.candidate.section,
          seq: pick.candidate.seq,
          text: pick.candidate.text,
          title: meta.title,
          summary: meta.summary,
          type: pick.candidate.type,
          project: pick.candidate.project,
          flags: pick.candidate.flags,
          fusedScore: 0,
          vectorScore: null,
          textScore: null,
          vectorRank: null,
          textRank: null,
          relation: pick.relation,
        });
      }

      return {
        hits,
        maxVectorScore,
        vectorCandidateCount: vectorRaw.length,
        textCandidateCount: textRaw.length,
      };
    },
  };
}

async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  const vectors = await embedder.embed([query]);
  const vector = vectors[0];
  if (vectors.length !== 1 || vector === undefined || vector.length !== embedder.dim) {
    throw new RetrieverError(
      RETRIEVER_ERROR_CODES.QUERY_VECTOR_INVALID,
      `embedder가 dim=${String(embedder.dim)} 벡터 1개를 돌려주지 않았다 ` +
        `(개수 ${String(vectors.length)}, 차원 ${String(vector?.length ?? "none")}). ` +
        "차원이 vec_idx와 다르면 $vectorSearch가 통째로 실패한다.",
    );
  }
  return vector;
}

/**
 * `vec_idx`의 filter 필드는 `meta.type`·`meta.project`·`embeddingVersion` **셋뿐**이다
 * (specs/02 §인덱스). 선언되지 않은 필드로 필터하면 필터가 무시되는 게 아니라
 * `Path '...' needs to be indexed as filter`로 **쿼리가 죽는다**
 * (`.claude/skills/mongo-vector-ops/SKILL.md`, T-010이 실측으로 잠갔다).
 * `ChunkMeta`에 있는 `severity`·`tags`를 여기 넣으면 안 되는 이유다.
 */
function buildVectorFilter(
  request: RetrieveOptions,
  embeddingVersion: number,
): Record<string, unknown> {
  return {
    embeddingVersion: { $eq: embeddingVersion },
    ...(request.type === undefined ? {} : { "meta.type": { $eq: request.type } }),
    ...(request.project === undefined ? {} : { "meta.project": { $eq: request.project } }),
  };
}

function buildVectorPipeline(
  queryVector: number[],
  request: RetrieveOptions,
  config: RetrievalConfig,
  embeddingVersion: number,
): PipelineStage[] {
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates: config.numCandidates,
        limit: config.vectorK * config.candidateOverfetch,
        filter: buildVectorFilter(request, embeddingVersion),
      },
    },
    { $project: { ...CANDIDATE_PROJECTION, score: { $meta: "vectorSearchScore" } } },
  ];
}

/**
 * 텍스트 경로의 필터는 `$search`의 `compound.filter`가 아니라 **뒤따르는 `$match`**로 건다.
 *
 * 근거: `text_idx` 정의(`db/search-indexes/text_idx.json`)는 `dynamic:false`에 `text` 필드
 * 하나만 매핑한다 — specs/02 §인덱스가 "path text (lucene.standard)"라고만 정했기 때문이다.
 * `meta.type`·`meta.project`·`embeddingVersion`은 그 인덱스에 **존재하지 않으므로**
 * `$search`의 `equals`로는 걸 수 없다. specs/03 §2는 "filter 동일"이라고만 하고
 * 거는 방식은 정하지 않았으므로, 인덱스 정의를 바꾸지 않고(인간 승인 사항) 같은 결과를 낸다.
 *
 * 대가: `$search`가 먼저 전 구간을 훑고 `$match`가 걸러낸다. `$limit`이 그 뒤에 와야
 * 필터로 잘려나간 만큼 재현율을 잃지 않는다.
 */
function buildTextPipeline(
  query: string,
  request: RetrieveOptions,
  config: RetrievalConfig,
  embeddingVersion: number,
): PipelineStage[] {
  return [
    { $search: { index: TEXT_INDEX_NAME, text: { query, path: "text" } } },
    {
      $match: {
        embeddingVersion,
        ...(request.type === undefined ? {} : { "meta.type": request.type }),
        ...(request.project === undefined ? {} : { "meta.project": request.project }),
      },
    },
    { $limit: config.textK * config.candidateOverfetch },
    { $project: { ...CANDIDATE_PROJECTION, score: { $meta: "searchScore" } } },
  ];
}

const CANDIDATE_PROJECTION: PipelineStage = {
  _id: 1,
  recordId: 1,
  section: 1,
  seq: 1,
  text: 1,
  meta: 1,
};

interface RecordMeta {
  readonly title: string;
  readonly summary: string;
}

/**
 * 최종 hit의 record만 조회한다(≤ limit건). 후보 단계에서 `$lookup`으로 붙이면
 * 버려질 후보 수십 건까지 조인하게 된다 — 그 비용을 낼 이유가 없다.
 *
 * `type`·`project`는 **청크의 비정규화 meta**에서 가져오므로 여기서 읽지 않는다.
 * 필터가 본 값과 결과가 보고하는 값이 같아야 한다.
 */
async function loadRecordMeta(
  db: RetrievalDbLike,
  candidates: readonly PathCandidate[],
): Promise<Map<string, RecordMeta>> {
  const rawIds: unknown[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.recordId)) continue;
    seen.add(candidate.recordId);
    rawIds.push(candidate.recordIdRaw);
  }
  if (rawIds.length === 0) return new Map();

  const docs = await db
    .collection(RECORDS_COLLECTION)
    .aggregate([
      { $match: { _id: { $in: rawIds } } },
      { $project: { _id: 1, title: 1, summary: 1 } },
    ])
    .toArray();

  return new Map(
    docs.map((doc) => [
      toIdString(doc["_id"]),
      { title: asString(doc["title"]), summary: asString(doc["summary"]) },
    ]),
  );
}

/**
 * 관계 확장을 실행한다 (specs/03 §2.5). **쿼리 2건**이다:
 *  1. `records`에서 `$graphLookup`으로 진입점의 1홉 대상을 찾고,
 *  2. `chunks`에서 그 대상들의 `resolution`/`prevention` 청크를 긁는다.
 *
 * 대상이 0건이면 2번을 **부르지 않는다** — `$in: []`은 항상 0건이라 낼 이유가 없는 왕복이다.
 * 선택 규칙(상한·중복·순서)은 전부 `relation-expansion.ts`의 순수 함수가 갖는다.
 */
async function expandByRelations(
  db: RetrievalDbLike,
  entries: readonly PathCandidate[],
  embeddingVersion: number,
): Promise<ExpansionPick<PathCandidate>[]> {
  // 진입점 = 융합 상위 hit이 속한 레코드. 순위 순서를 유지한 채 중복만 없앤다.
  const entryOrder: string[] = [];
  const entryIdsRaw: unknown[] = [];
  const seenEntry = new Set<string>();
  for (const entry of entries) {
    if (seenEntry.has(entry.recordId)) continue;
    seenEntry.add(entry.recordId);
    entryOrder.push(entry.recordId);
    entryIdsRaw.push(entry.recordIdRaw);
  }
  if (entryIdsRaw.length === 0) return [];

  const lookupDocs = await db
    .collection(RECORDS_COLLECTION)
    .aggregate(buildRelationLookupPipeline(entryIdsRaw, RECORDS_COLLECTION))
    .toArray();

  const targets = parseRelationTargets(lookupDocs, entryOrder, toIdString);
  if (targets.length === 0) return [];

  const targetIdsRaw: unknown[] = [];
  const seenTarget = new Set<string>();
  for (const target of targets) {
    if (seenTarget.has(target.targetRecordId)) continue;
    seenTarget.add(target.targetRecordId);
    targetIdsRaw.push(target.targetRecordIdRaw);
  }

  const chunkDocs = await db
    .collection(CHUNKS_COLLECTION)
    .aggregate(buildRelationChunkPipeline(targetIdsRaw, embeddingVersion, CANDIDATE_PROJECTION))
    .toArray();

  const candidates = chunkDocs.map((doc) => parseCandidate(doc, "relation"));
  const exclude = new Set(entries.map((entry) => entry.chunkId));
  return selectExpansionChunks(candidates, targets, exclude, MAX_RELATION_CHUNKS);
}

/**
 * `path`가 `"relation"`이면 관계 확장으로 들어온 청크다 — 검색 경로가 아니므로 점수가
 * 없고, 파이프라인이 `score: 0`을 투영해 넣는다. 검사는 나머지 두 경로와 **똑같이** 엄격하다:
 * 확장 청크라고 빈 본문을 통과시키면 근거 없는 인용이 관계를 타고 들어온다.
 */
function parseCandidate(
  doc: Record<string, unknown>,
  path: "vector" | "text" | "relation",
): PathCandidate {
  const meta = isRecord(doc["meta"]) ? doc["meta"] : {};
  const score = doc["score"];
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new RetrieverError(
      RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
      `${path} 경로 후보에 유효한 score가 없다(받은 값: ${String(score)}). ` +
        "$meta 투영이 빠졌거나 인덱스가 기대한 종류가 아니다.",
    );
  }

  const section = ChunkSection.safeParse(doc["section"]);
  const type = RecordType.safeParse(meta["type"]);
  if (!section.success || !type.success) {
    throw new RetrieverError(
      RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
      `chunks 도큐먼트가 스키마와 다르다(section=${String(doc["section"])}, ` +
        `meta.type=${String(meta["type"])}). 인제스트가 잘못된 청크를 썼다.`,
    );
  }

  /*
   * `text`·`project`·`seq`도 `section`·`type`과 **같은 강도**로 검사한다.
   * 한 함수 안에서 엄격/관대가 갈릴 근거가 없고, `packages/contracts/src/chunk.ts`가
   * `text: z.string().min(1)`·`project: z.string().min(1)`·`seq: int().nonnegative()`를
   * 요구하므로 위반은 전부 인제스트 결함이다. 조용히 강등하면:
   *  - 빈 `text` 청크가 T-018 생성 컨텍스트로 흘러가 **인용은 만들어지는데 근거가 없는** 상태가 되고,
   *  - 빈 `project`는 결과가 보고하는 소속을 지워 필터가 본 값과 어긋나며,
   *  - `seq`를 0으로 접으면 청크 identity `{recordId,section,seq,embeddingVersion}`가 충돌해
   *    서로 다른 청크가 같은 것으로 보인다.
   * `CANDIDATE_PROJECTION`이 세 필드를 항상 싣으므로, 없다는 것 자체가 데이터 무결성 문제다.
   */
  const text = doc["text"];
  const project = meta["project"];
  const seq = doc["seq"];
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    typeof project !== "string" ||
    project.length === 0 ||
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0
  ) {
    throw new RetrieverError(
      RETRIEVER_ERROR_CODES.CANDIDATE_INVALID,
      `chunks 도큐먼트가 스키마와 다르다(text 길이=${String(
        typeof text === "string" ? text.length : "none",
      )}, meta.project=${String(project)}, seq=${String(seq)}). ` +
        "인제스트가 잘못된 청크를 썼다 — 빈 본문은 근거 없는 인용으로 이어진다.",
    );
  }

  return {
    chunkId: toIdString(doc["_id"]),
    recordId: toIdString(doc["recordId"]),
    recordIdRaw: doc["recordId"],
    section: section.data,
    seq,
    text,
    type: type.data,
    project,
    flags: parseFlags(meta["sanitizeFlags"]),
    /*
     * **환산은 여기 한 곳뿐이다.** vector 경로만 cosine 척도이고, text 경로의
     * `searchScore`(BM25)는 cosine이 아니라 무제한 척도라 손대지 않는다.
     */
    score: path === "vector" ? toRawCosine(score) : score,
  };
}

/**
 * Atlas `$vectorSearch`의 `vectorSearchScore`를 **원시 cosine**으로 되돌린다.
 *
 * Atlas는 `similarity:"cosine"` 인덱스에서 원시 cosine을 주지 않는다. `(1 + cos) / 2`로
 * 정규화한 0–1 값을 준다. T-011 검증에서 실측했다(질의 벡터와의 각도 → 반환값):
 *
 *   동일 1.0 / 45° 0.8536 / 60° 0.75 / 직교 0.5 / 120° 0.25 / 정반대 0.0
 *
 * 그대로 돌려주면 specs/03 §4가 "**원시 cosine** 최고점과 비교하라"고 정한
 * `SIMILARITY_THRESHOLD=0.62`가 실제로는 원시 cosine 0.24 게이트가 되어 의도보다 훨씬 헐거워진다.
 * 그래서 retriever가 `cos = 2·s − 1`로 되돌려서 돌려준다 — 반환 범위는 0–1이 아니라 **−1..1**이다.
 * 이 사실이 코드에서 사라지면 다음 사람이 같은 값을 한 번 더 환산한다.
 *
 * ⚠️ 이 식은 `similarity:"cosine"` 인덱스에서만 맞다. `vec_idx`가 euclidean/dotProduct로
 * 드리프트하면(T-010 F-7) 정규화 식 자체가 달라져 이 환산이 조용히 틀린 값을 낸다.
 * `retrieve.int.spec.ts`의 "동일 ≈1 / 직교 ≈0 / 정반대 ≈−1" 단언이 그 유일한 방어선이다.
 *
 * (여기 `2`는 수학 상수지 튜닝 값이 아니다. `no-hardcoded-params.spec.ts`가 리터럴을 문자로
 *  찾으므로 `RETRIEVAL_MAX_CHUNKS_PER_RECORD=2`와 구별하지 못한다 — 그쪽의
 *  `MATH_CONSTANT_EXEMPTIONS`에 이 식이 **표현식 그대로** 등재돼 있다.)
 */
function toRawCosine(normalized: number): number {
  return 2 * normalized - 1;
}

/** 알 수 없는 플래그는 버린다. `SanitizeFlag`가 아닌 값이 다운스트림 분기에 새면 안 된다. */
function parseFlags(raw: unknown): SanitizeFlag[] {
  if (!Array.isArray(raw)) return [];
  const flags: SanitizeFlag[] = [];
  for (const value of raw) {
    const parsed = SanitizeFlag.safeParse(value);
    if (parsed.success) flags.push(parsed.data);
  }
  return flags;
}

/**
 * `ObjectId`를 hex 문자열로. bson을 import하지 않으려고 구조적으로 검사한다
 * (`types.ts`의 "mongodb 미의존" 결정). 이미 문자열이면 그대로 돌려준다.
 */
function toIdString(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    isRecord(value) &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString(): string }).toHexString();
  }
  return String(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
