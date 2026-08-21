/**
 * 이 파일은 T-002의 출발점이자, API·MCP 계약의 단일 소스다.
 * 여기 정의된 스키마 외의 타입을 다른 패키지에서 재정의하지 않는다. (CLAUDE.md 규칙)
 * 전체 스펙: specs/02-data-model.md, specs/04-api.md
 */
import { z } from "zod";

export const Severity = z.enum(["SEV1", "SEV2", "SEV3", "NOTE"]);
export const RecordType = z.enum(["incident", "divergence"]);

const BaseRecord = z.object({
  title: z.string().min(4).max(200),
  severity: Severity.default("NOTE"),
  tags: z.array(z.string()).max(20).default([]),
});

export const IncidentInput = BaseRecord.extend({
  type: z.literal("incident"),
  symptom: z.string().min(10),
  rootCause: z.string().optional(),
  resolution: z.string().min(10),
  prevention: z.string().optional(),
});

export const DivergenceInput = BaseRecord.extend({
  type: z.literal("divergence"),
  expected: z.string().min(10),
  actual: z.string().min(10),
  context: z.object({
    model: z.string().optional(),
    tool: z.string().optional(),
    framework: z.string().optional(),
  }).default({}),
  correction: z.string().min(10),
});

/** project는 서버가 인증 키에서 주입한다. 클라이언트 값은 무시된다. (specs/04) */
export const CreateRecordInput = z.discriminatedUnion("type", [IncidentInput, DivergenceInput]);

export const SearchRequest = z.object({
  query: z.string().min(2),
  type: RecordType.optional(),
  project: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export const SearchHit = z.object({
  recordId: z.string(),
  title: z.string(),
  summary: z.string(),        // 본문 미포함 — NFR-03
  section: z.string(),
  score: z.number(),
  type: RecordType,
  project: z.string(),
  flags: z.array(z.string()).default([]),
});

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type CreateRecordInput = z.infer<typeof CreateRecordInput>;
export type SearchRequest = z.infer<typeof SearchRequest>;
export type SearchHit = z.infer<typeof SearchHit>;
