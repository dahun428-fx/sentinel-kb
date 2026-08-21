/**
 * chunks 컬렉션 스키마. 출처: specs/02-data-model.md
 */
import { z } from "zod";

import {
  ChunkSection,
  ObjectIdString,
  RecordType,
  SanitizeFlag,
  Severity,
} from "./common.js";

/**
 * Atlas Vector Search 필터에 쓰이는 비정규화 메타데이터.
 * meta.type / meta.project / embeddingVersion이 벡터 인덱스 필터 필드다 (specs/02).
 */
export const ChunkMeta = z
  .object({
    type: RecordType,
    project: z.string().min(1),
    severity: Severity,
    tags: z.array(z.string()),
    sanitizeFlags: z.array(SanitizeFlag),
  })
  .strict();
export type ChunkMeta = z.infer<typeof ChunkMeta>;

/**
 * 청크. embedding 차원은 EMBEDDING_DIM 환경값이라 스키마에 고정하지 않는다 —
 * 모델명·차원 하드코딩 금지(CLAUDE.md), 버전은 embeddingVersion으로만 식별한다.
 */
export const ChunkSchema = z
  .object({
    _id: ObjectIdString,
    recordId: ObjectIdString,
    section: ChunkSection,
    /**
     * 같은 섹션 안에서의 분할 순번(0부터). specs/03 §1-3의 upsert 유니크 키
     * `{recordId, section, seq, embeddingVersion}`의 일부다.
     * 1200자를 넘겨 문단 경계로 쪼개진 섹션은 청크가 여러 개 나오는데, seq가 없으면
     * 2번째 청크가 1번째를 같은 키로 덮어써 본문이 조용히 사라진다. (T-005)
     */
    seq: z.number().int().nonnegative(),
    text: z.string().min(1),
    embedding: z.array(z.number()).min(1),
    meta: ChunkMeta,
    embeddingVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ChunkSchema = z.infer<typeof ChunkSchema>;
