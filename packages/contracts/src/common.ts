/**
 * 도메인 공통 원시 스키마 — 열거형, 식별자, 관계.
 * 출처: specs/02-data-model.md
 */
import { z } from "zod";

/** 심각도. specs/02 records.severity */
export const Severity = z.enum(["SEV1", "SEV2", "SEV3", "NOTE"]);
export type Severity = z.infer<typeof Severity>;

/** 레코드 종류. incident(장애) | divergence(AI 개발 이격) */
export const RecordType = z.enum(["incident", "divergence"]);
export type RecordType = z.infer<typeof RecordType>;

/** 게시 상태. specs/02 records.status */
export const RecordStatus = z.enum(["draft", "published"]);
export type RecordStatus = z.infer<typeof RecordStatus>;

/**
 * 새니타이즈 플래그. specs/02가 명시한 2종만 허용한다.
 * 임의 문자열을 허용하면 다운스트림 필터가 조용히 새는다.
 */
export const SanitizeFlag = z.enum(["secret-masked", "injection-suspect"]);
export type SanitizeFlag = z.infer<typeof SanitizeFlag>;

/** 명시적 관계 종류. ADR-07 단계 0 — 기록자가 직접 연결하며 LLM 자동 추출은 금지다. */
export const RelationType = z.enum([
  "recurrence_of",
  "same_root_cause",
  "related",
  "corrects",
]);
export type RelationType = z.infer<typeof RelationType>;

/** 청크가 유래한 본문 섹션. specs/02 chunks.section */
export const ChunkSection = z.enum([
  "symptom",
  "rootCause",
  "resolution",
  "prevention",
  "expected",
  "actual",
  "correction",
]);
export type ChunkSection = z.infer<typeof ChunkSection>;

/**
 * MongoDB ObjectId의 문자열 표현(24자 hex).
 * contracts는 최하위 계층이라 DB 드라이버(bson)를 알지 못한다 — 문자열로만 다룬다.
 */
export const ObjectIdString = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "24자 hex ObjectId 문자열이어야 한다");
export type ObjectIdString = z.infer<typeof ObjectIdString>;

/** 레코드 간 명시적 관계. specs/02 records.relations */
export const Relation = z
  .object({
    type: RelationType,
    targetRecordId: ObjectIdString,
    note: z.string().max(500).optional(),
  })
  .strict();
export type Relation = z.infer<typeof Relation>;
