/**
 * records 컬렉션 도큐먼트와 생성·수정 입력 스키마.
 * 출처: specs/02-data-model.md, specs/04-api.md
 */
import { z } from "zod";

import {
  ObjectIdString,
  RecordStatus,
  RecordType,
  Relation,
  SanitizeFlag,
  Severity,
} from "./common.js";

/** divergence 전용 재현 맥락. 어떤 모델·도구·프레임워크에서 벌어졌는지. */
export const DivergenceContext = z
  .object({
    model: z.string().optional(),
    tool: z.string().optional(),
    framework: z.string().optional(),
  })
  .strict();
export type DivergenceContext = z.infer<typeof DivergenceContext>;

const BaseRecordInput = z.object({
  title: z.string().min(4).max(200),
  severity: Severity.default("NOTE"),
  tags: z.array(z.string()).max(20).default([]),
  /**
   * 기본값이 `published`인 이유: 주 유입 경로인 MCP `record_knowledge`는 이미 해결된
   * 사례를 기록하므로 즉시 검색 가능해야 한다. specs/03 §1-1이 embed job을
   * `published` 저장에 걸어두었으므로, 기본이 draft면 POST→PATCH 2단계를 거치기
   * 전까지 어떤 레코드도 임베딩되지 않는다.
   * draft는 포스트모템 위저드(FR-09, P2)가 작성 중인 초안을 남길 때 쓰는 예외다.
   */
  status: RecordStatus.default("published"),
});

/**
 * incident 입력. `.strict()`가 핵심이다 — divergence 전용 필드(expected/actual/
 * correction)를 섞어 넣으면 조용히 버려지는 대신 파싱이 실패한다. (T-002 Acceptance 1)
 */
export const IncidentInput = BaseRecordInput.extend({
  type: z.literal("incident"),
  symptom: z.string().min(10),
  rootCause: z.string().optional(),
  resolution: z.string().min(10),
  prevention: z.string().optional(),
}).strict();
export type IncidentInput = z.infer<typeof IncidentInput>;

/** divergence 입력. expected/actual/correction이 이 종류의 존재 이유이므로 필수다. */
export const DivergenceInput = BaseRecordInput.extend({
  type: z.literal("divergence"),
  expected: z.string().min(10),
  actual: z.string().min(10),
  context: DivergenceContext.default({}),
  correction: z.string().min(10),
}).strict();
export type DivergenceInput = z.infer<typeof DivergenceInput>;

/** project는 서버가 인증 키에서 주입한다. 클라이언트 값은 받지 않는다. (specs/04) */
export const CreateRecordInput = z.discriminatedUnion("type", [
  IncidentInput,
  DivergenceInput,
]);
export type CreateRecordInput = z.infer<typeof CreateRecordInput>;

/**
 * 부분 수정 입력.
 * - `type`은 patch 대상이 아니다 — `.strict()`가 종류 변경 시도를 거부한다.
 * - `project`도 마찬가지로 서버 소유 필드라 여기에 없다.
 * - 빈 객체는 거부한다(수정 의도 없는 PATCH는 계약 위반).
 */
export const PatchRecordInput = z
  .object({
    title: z.string().min(4).max(200),
    severity: Severity,
    tags: z.array(z.string()).max(20),
    status: RecordStatus,
    relations: z.array(Relation).max(50),
    symptom: z.string().min(10),
    rootCause: z.string().min(1),
    resolution: z.string().min(10),
    prevention: z.string().min(1),
    expected: z.string().min(10),
    actual: z.string().min(10),
    context: DivergenceContext,
    correction: z.string().min(10),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "수정할 필드를 최소 1개 지정해야 한다",
  });
export type PatchRecordInput = z.infer<typeof PatchRecordInput>;

/** 저장된 레코드의 공통 필드. specs/02 records */
const BaseRecordDocument = z.object({
  _id: ObjectIdString,
  project: z.string().min(1),
  title: z.string().min(4).max(200),
  /**
   * 서버가 생성한다(첫 2문장 또는 LLM 요약 캐시). `CreateRecordInput`에 없는 이유가
   * 이것이다 — 클라이언트가 넣으면 `.strict()`가 거부한다.
   * 목록·검색 응답이 본문 대신 이걸 싣는 것이 NFR-03의 기반이다. (specs/04 규약)
   */
  summary: z.string().min(1),
  severity: Severity,
  tags: z.array(z.string()).max(20),
  sanitizeFlags: z.array(SanitizeFlag),
  relations: z.array(Relation),
  status: RecordStatus,
  embeddingVersion: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const IncidentRecord = BaseRecordDocument.extend({
  type: z.literal("incident"),
  symptom: z.string().min(1),
  rootCause: z.string().min(1).optional(),
  resolution: z.string().min(1),
  prevention: z.string().min(1).optional(),
});
export type IncidentRecord = z.infer<typeof IncidentRecord>;

export const DivergenceRecord = BaseRecordDocument.extend({
  type: z.literal("divergence"),
  expected: z.string().min(1),
  actual: z.string().min(1),
  context: DivergenceContext,
  correction: z.string().min(1),
});
export type DivergenceRecord = z.infer<typeof DivergenceRecord>;

/** 저장된 레코드. type으로 갈라지는 판별 유니온이다. */
export const RecordSchema = z.discriminatedUnion("type", [
  IncidentRecord,
  DivergenceRecord,
]);
export type RecordSchema = z.infer<typeof RecordSchema>;

/**
 * 목록 응답용 레코드 요약.
 *
 * specs/04는 "(본문 포함)"을 **단건 조회에만** 달아 목록과 구분한다. 목록이 전
 * 레코드의 본문을 실어 나르면 이를 감싸는 MCP 도구가 즉시 NFR-03(토큰 예산)을
 * 위반한다 — 그래서 본문 섹션(symptom/rootCause/resolution/prevention/expected/
 * actual/correction/context)은 여기 **없다**. 본문이 필요하면 `GET /v1/records/:id`
 * 또는 MCP `get_record`를 부른다.
 *
 * `.strict()`가 그 경계를 강제한다 — 나중에 누가 본문 필드를 끼워 넣으면 파싱이
 * 실패한다. type은 판별자가 아니라 단순 분류값이므로 유니온이 아닌 평면 객체다.
 */
export const RecordSummary = z
  .object({
    _id: ObjectIdString,
    type: RecordType,
    project: z.string().min(1),
    title: z.string().min(4).max(200),
    /** 본문을 싣지 않는 대신 판단 근거가 되는 필드. 이게 빠지면 요약이 무의미해진다. */
    summary: z.string().min(1),
    severity: Severity,
    tags: z.array(z.string()).max(20),
    sanitizeFlags: z.array(SanitizeFlag),
    status: RecordStatus,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type RecordSummary = z.infer<typeof RecordSummary>;
