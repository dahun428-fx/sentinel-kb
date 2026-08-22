/**
 * 인제스트 파이프라인 — record 1건을 청크로 만들어 커밋한다.
 * 출처: specs/03-rag-pipeline.md §1-2·§1-3, specs/02-data-model.md(chunks, 마이그레이션 규칙).
 *
 * 순서가 곧 안전성이다:
 *   1. record 로드   2. 청킹   3. 임베딩   4. chunks upsert
 *   5. **고아 청크 삭제**   6. **record.embeddingVersion 워터마크 상승**
 *
 * 5·6이 4 뒤에 오는 것은 취향이 아니다. 중간에 프로세스가 죽으면 워터마크가 낮은 채로 남아
 * 다음 시도가 같은 세대를 다시 커밋한다(멱등하므로 무해). 반대로 워터마크를 먼저 올리면
 * "임베딩됐다고 주장하지만 청크가 없는 record"가 남고, 그 상태는 워커가 스스로 고칠 수 없다.
 */
import type { ChunkMeta, ChunkSchema, RecordSchema } from "@sentinel/contracts";
import { RecordSchema as RecordDocumentSchema } from "@sentinel/contracts";
import { chunkRecord, type Embedder, type SectionChunk } from "@sentinel/core";
import { toContractRecord } from "@sentinel/core/db";
import { ObjectId, type Db, type Filter } from "mongodb";

import { WORKER_ERROR_CODES, WorkerError } from "./errors.js";

/**
 * 저장된 청크. contracts의 `ChunkSchema`에서 파생한다 — 식별자만 DB 표현(`ObjectId`)으로 바꾼다.
 */
export type ChunkDocument = Omit<ChunkSchema, "_id" | "recordId"> & {
  _id: ObjectId;
  recordId: ObjectId;
};

export interface IngestResult {
  /** 이번에 커밋한 청크 수. */
  readonly chunkCount: number;
  /** 이번 커밋 키 집합 밖이라 지운 같은 세대 청크 수. */
  readonly deletedOrphans: number;
  /** 커밋한 세대. `embedder.version`이다. */
  readonly embeddingVersion: number;
}

export async function ingestRecord(
  db: Db,
  recordId: ObjectId,
  embedder: Embedder,
): Promise<IngestResult> {
  const record = await loadRecord(db, recordId);
  const sectionChunks = chunkRecord(record);
  const vectors = await embedChunks(embedder, sectionChunks);

  /**
   * **청크의 세대는 `embedder.version`이지 `record.embeddingVersion`이 아니다**(T-006 확정,
   * 근거는 specs/02:84 유니크 키). record 쪽 값은 "마지막으로 온전히 임베딩된 세대" 워터마크이며
   * 재임베딩 창에서 둘이 다른 것은 **정상**이다 — 에러로 취급하지 않는다.
   */
  const embeddingVersion = embedder.version;
  const meta = toChunkMeta(record);

  await upsertChunks(db, recordId, embeddingVersion, meta, sectionChunks, vectors);
  const deletedOrphans = await deleteOrphanChunks(db, recordId, embeddingVersion, sectionChunks);
  await raiseEmbeddingWatermark(db, recordId, embeddingVersion);

  return { chunkCount: sectionChunks.length, deletedOrphans, embeddingVersion };
}

function chunks(db: Db) {
  return db.collection<ChunkDocument>("chunks");
}

/**
 * `{recordId, section, seq, embeddingVersion}` 유니크 키로 upsert한다(specs/03 §1-3).
 * insert가 아니라 upsert여야 하는 이유는 재시도다 — 같은 잡이 두 번 돌면 insert는
 * `duplicate key`로 죽고, 그 실패가 attempts를 태워 멀쩡한 잡을 dead로 보낸다.
 */
async function upsertChunks(
  db: Db,
  recordId: ObjectId,
  embeddingVersion: number,
  meta: ChunkMeta,
  sectionChunks: readonly SectionChunk[],
  vectors: readonly number[][],
): Promise<void> {
  if (sectionChunks.length === 0) return;

  const operations = sectionChunks.map((chunk, index) => {
    const embedding = vectors[index];
    if (embedding === undefined) {
      throw new WorkerError(
        WORKER_ERROR_CODES.EMBEDDING_COUNT_MISMATCH,
        `청크 ${String(index)}에 대응하는 벡터가 없다. embedder가 입력 순서·개수를 보존하지 않았다.`,
      );
    }
    return {
      updateOne: {
        // 필터에 쓴 등가 필드는 upsert insert 시 그대로 도큐먼트에 들어간다.
        filter: { recordId, section: chunk.section, seq: chunk.seq, embeddingVersion },
        update: { $set: { text: chunk.text, embedding, meta } },
        upsert: true,
      },
    };
  });

  await chunks(db).bulkWrite(operations);
}

/**
 * **고아 청크 삭제** (T-005 F-2). 어느 스펙에도 없던 단계라 여기서 메운다.
 *
 * 청킹은 greedy packing이라 본문이 바뀌면 조각 경계가 밀린다. upsert는 같은 키를 덮어쓰므로
 * 중복은 안 생기지만, **청크 수가 줄어드는 수정에서는 꼬리 청크(seq가 큰 쪽)가 살아남아
 * 구 본문·구 임베딩을 단 채 검색에 계속 잡힌다.** 지운 문장이 영원히 검색되는 셈이다.
 *
 * `embeddingVersion`으로 반드시 좁힌다. 세대 무관하게 지우면 specs/02 마이그레이션 규칙
 * ("신규 버전 삽입 → 검색 필터 스왑 → **구버전 청크 삭제**")이 깨진다 — 신 세대를 쓰는 동안
 * 아직 서비스 중인 구 세대 청크가 사라져 무중단 재임베딩이 무중단이 아니게 된다.
 */
async function deleteOrphanChunks(
  db: Db,
  recordId: ObjectId,
  embeddingVersion: number,
  sectionChunks: readonly SectionChunk[],
): Promise<number> {
  const scope: Filter<ChunkDocument> = { recordId, embeddingVersion };
  // `$nor: []`는 Mongo가 거부한다. 청크가 하나도 안 나온 record(본문이 통째로 비워진 경우)는
  // 이번 세대 전부가 고아다.
  const filter: Filter<ChunkDocument> =
    sectionChunks.length === 0
      ? scope
      : { ...scope, $nor: sectionChunks.map(({ section, seq }) => ({ section, seq })) };

  const { deletedCount } = await chunks(db).deleteMany(filter);
  return deletedCount;
}

/**
 * **`record.embeddingVersion` 워터마크 상승.**
 *
 * T-006 F-1b: 이 필드에 쓰기 주체를 배정한 스펙이 하나도 없었다. 현행대로면 생성 시 한 번
 * 쓰이고 영구히 stale하다. T-008의 결정은 **워커가 유일한 쓰기 주체**이며, 세대 N 청크를
 * **전부 커밋한 뒤에만** N으로 올린다는 것이다. 그래서 이 호출이 파이프라인의 마지막이다.
 * `RecordSchema`가 `nonnegative()`라 `0`이 "아직 임베딩 안 됨" 센티널로 성립하고
 * contracts 변경이 필요 없다. (specs/02 records 블록에 명시. 인간 사후 비준 대상 — Findings)
 *
 * `updatedAt`은 건드리지 않는다. 본문이 바뀐 게 아니라 시스템이 워터마크를 옮긴 것이고,
 * 재임베딩 때마다 "최근 수정" 표시가 요동치면 안 된다.
 * (목록 정렬은 `createdAt` 기준이라 영향받지 않는다.)
 *
 * **`$set`이 아니라 `$max`다.** `$set`이면 **낮은 세대 워커가 워터마크를 되돌린다** —
 * 재임베딩 창에서 구·신 워커가 병존할 때 세대 5까지 올라간 값이 세대 1 워커의 처리로 1이 된다.
 * 워터마크는 "마지막으로 온전히 임베딩된 세대"이므로 **단조 증가**여야 하고,
 * 되돌아가면 백필 커서(`records.find({embeddingVersion: {$lt: N}})`)가 이미 끝난 record를
 * 무한히 다시 집는다. (T-008 V13)
 */
async function raiseEmbeddingWatermark(
  db: Db,
  recordId: ObjectId,
  embeddingVersion: number,
): Promise<void> {
  await db.collection("records").updateOne({ _id: recordId }, { $max: { embeddingVersion } });
}

/** 빈 배치로 임베딩 API를 때리지 않는다. 비용은 없어도 provider가 400으로 답할 수 있다. */
async function embedChunks(
  embedder: Embedder,
  sectionChunks: readonly SectionChunk[],
): Promise<number[][]> {
  if (sectionChunks.length === 0) return [];
  const vectors = await embedder.embed(sectionChunks.map((chunk) => chunk.text));
  if (vectors.length !== sectionChunks.length) {
    throw new WorkerError(
      WORKER_ERROR_CODES.EMBEDDING_COUNT_MISMATCH,
      `청크 ${String(sectionChunks.length)}개에 벡터 ${String(vectors.length)}개가 돌아왔다.`,
    );
  }
  return vectors;
}

/** 벡터 인덱스 필터에 쓰이는 비정규화 메타(specs/02 chunks.meta). record가 유일한 출처다. */
function toChunkMeta(record: RecordSchema): ChunkMeta {
  return {
    type: record.type,
    project: record.project,
    severity: record.severity,
    tags: record.tags,
    sanitizeFlags: record.sanitizeFlags,
  };
}

/**
 * record 로드 + DB 경계 매핑. specs/02가 "ObjectId↔string 매핑은 DB 경계의 책임"이라고
 * 명시했으므로 hex 문자열로 바꾼 뒤 contracts 스키마로 검증한다.
 * 검증을 건너뛰면 형상이 깨진 도큐먼트가 chunker까지 흘러가 `undefined` 섹션을 조용히
 * 스킵하고 **본문 없는 청크**를 만든다 — 검색에서만 뒤늦게 드러나는 종류의 손상이다.
 */
async function loadRecord(db: Db, recordId: ObjectId): Promise<RecordSchema> {
  const document = await db.collection("records").findOne({ _id: recordId });
  if (document === null) {
    throw new WorkerError(
      WORKER_ERROR_CODES.RECORD_NOT_FOUND,
      `record ${recordId.toHexString()}가 없다. 잡보다 먼저 삭제됐을 수 있다.`,
    );
  }

  const parsed = RecordDocumentSchema.safeParse(toContractRecord(document));
  if (!parsed.success) {
    throw new WorkerError(
      WORKER_ERROR_CODES.RECORD_INVALID,
      `record ${recordId.toHexString()}가 RecordSchema를 만족하지 않는다: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
}

// 매핑 자체는 `@sentinel/core/db`에 있다. T-007이 같은 변환을 쓰게 되면서 소비자가 둘이 됐고,
// T-008 F-4가 "그 시점에 판단하라"고 미뤄 둔 승격 시점이 거기였다.
