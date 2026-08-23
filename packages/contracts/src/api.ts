/**
 * HTTP 요청·응답 스키마. 출처: specs/04-api.md
 * Base는 `/v1`, 인증은 `Authorization: Bearer <key>` → `{ project }` 클레임 (NFR-04).
 */
import { z } from "zod";

import { ArticleStatus, ArticleSummary } from "./article.js";
import {
  ChunkSection,
  ObjectIdString,
  RecordType,
  SanitizeFlag,
} from "./common.js";
import { RecordSummary } from "./record.js";

/** `/v1/records/:id` 경로 파라미터 */
export const RecordIdParam = z.object({ id: ObjectIdString }).strict();
export type RecordIdParam = z.infer<typeof RecordIdParam>;

/**
 * GET /v1/records 쿼리.
 * 페이지네이션은 cursor(`createdAt+_id`) 방식이며 offset은 금지다 (specs/04 규약).
 * `.strict()`가 `offset` 같은 미승인 파라미터를 거부해 규약을 스키마로 강제한다.
 */
export const ListRecordsQuery = z
  .object({
    project: z.string().min(1).optional(),
    type: RecordType.optional(),
    tags: z.array(z.string()).max(20).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListRecordsQuery = z.infer<typeof ListRecordsQuery>;

/** cursor 페이지네이션 응답 래퍼. 마지막 페이지면 nextCursor는 null이다. */
export const CursorPage = <ItemSchema extends z.ZodTypeAny>(
  itemSchema: ItemSchema,
) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });
export interface CursorPage<Item> {
  items: Item[];
  nextCursor: string | null;
}

/**
 * GET /v1/records 응답.
 * 항목은 본문 없는 `RecordSummary`다 — specs/04는 "(본문 포함)"을 단건 조회에만
 * 달았고, 목록이 본문을 실으면 이를 감싸는 MCP 도구가 NFR-03을 즉시 위반한다.
 */
export const ListRecordsResponse = CursorPage(RecordSummary);
export type ListRecordsResponse = z.infer<typeof ListRecordsResponse>;

// ---------------------------------------------------------------- 아티클 (B-1, specs/04 표)

/** `/v1/articles/:id` 경로 파라미터 */
export const ArticleIdParam = z.object({ id: ObjectIdString }).strict();
export type ArticleIdParam = z.infer<typeof ArticleIdParam>;

/**
 * GET /v1/articles 쿼리.
 *
 * ## `status`의 기본값이 이 스키마에서 가장 중요한 한 줄이다
 * specs/04: "**기본은 `published`만.** `status=candidate|draft`를 **명시해야** 후보 큐가 보인다."
 * 근거는 표 아래 블록쿼트에 있다:
 * > T-033 Acceptance 3이 "candidate는 공개 목록에 노출되지 않는다"이므로 **필터를 빠뜨렸을 때의
 * > 결과가 안전한 쪽**이어야 한다. 반대로 두면 파라미터 하나를 잊는 순간 미발행 초안이 공개된다.
 *
 * 그래서 `.optional()`이 아니라 `.default("published")`다. 이 둘의 차이가 곧 노출 사고다 —
 * `optional`이면 파싱 결과가 `undefined`가 되고, 호출부가 "필터 없음 = 전체"로 읽는 것이
 * 가장 자연스러운 구현이 된다. 기본값을 **계약에** 두면 라우트가 잊을 수 없다.
 *
 * 단일 값만 받고 배열을 받지 않는 것도 같은 축이다. `status=published&status=candidate` 같은
 * 다중 필터를 허용하면 "명시해야 보인다"가 "하나만 명시하면 나머지도 딸려온다"로 새어 나간다.
 *
 * `kind` 필터는 **일부러 두지 않았다.** specs/04 표에 없고, `articles_status_createdAt`
 * 인덱스가 커버하지 못하는 조회 패턴을 계약으로 약속하게 된다(B-1 인덱스 판단 참조).
 */
export const ListArticlesQuery = z
  .object({
    status: ArticleStatus.default("published"),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListArticlesQuery = z.infer<typeof ListArticlesQuery>;

/**
 * GET /v1/articles 응답. 항목은 본문 없는 `ArticleSummary`다 —
 * specs/04 표가 아티클 목록 행에 "**본문 없는 요약**"을 명시했고, 근거는 `RecordSummary`와 같다(NFR-03).
 */
export const ListArticlesResponse = CursorPage(ArticleSummary);
export type ListArticlesResponse = z.infer<typeof ListArticlesResponse>;

/** POST /v1/search 바디 */
export const SearchRequest = z
  .object({
    query: z.string().min(2),
    type: RecordType.optional(),
    project: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequest>;

/**
 * 검색 결과 1건. `summary`는 서버가 생성하며 본문은 포함하지 않는다 —
 * 클라이언트가 본문 없이 판단할 수 있어야 한다 (NFR-03).
 */
export const SearchHit = z
  .object({
    recordId: ObjectIdString,
    title: z.string(),
    summary: z.string(), // 본문 미포함 — NFR-03
    section: ChunkSection,
    score: z.number(),
    type: RecordType,
    project: z.string(),
    flags: z.array(SanitizeFlag).default([]),
  })
  .strict();
export type SearchHit = z.infer<typeof SearchHit>;

/** POST /v1/search 응답 */
export const SearchResponse = z.object({ results: z.array(SearchHit) }).strict();
export type SearchResponse = z.infer<typeof SearchResponse>;

/**
 * POST /v1/answer 바디.
 * `stream`은 specs/04:13의 "SSE 스트리밍 옵션"에 대응한다. `.strict()`가 미승인
 * 키를 거부하므로, 자리를 지금 열어두지 않으면 나중에 붙이는 순간 breaking change가 된다.
 */
export const AnswerRequest = z
  .object({
    query: z.string().min(2),
    project: z.string().optional(),
    stream: z.boolean().default(false),
  })
  .strict();
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** 답변 근거 인용. 어떤 레코드의 어떤 섹션에서 왔는지 추적 가능해야 한다. */
export const Citation = z
  .object({
    recordId: ObjectIdString,
    section: ChunkSection,
    title: z.string(),
    score: z.number(),
  })
  .strict();
export type Citation = z.infer<typeof Citation>;

/**
 * POST /v1/answer 응답.
 *
 * `found`로 갈라지는 판별 유니온이며, found:true 갈래는 `citations`를 1개 이상
 * 요구한다. 근거 없는 생성을 스키마 레벨에서 불가능하게 만든다 (FR-04, NFR-02).
 * 근거가 없으면 답변을 지어내는 대신 found:false 갈래로만 응답할 수 있다.
 *
 * found:false 갈래는 specs/03:39·specs/07:32·T-018이 합의한 모양 그대로다.
 * `suggestRecord`는 산문이 아니라 **기계 판독 신호**다 — MCP 에이전트가 이 필드를
 * 보고 `record_knowledge`로 유도된다. `z.boolean()`이 아니라 `z.literal(true)`인
 * 이유: found:false인데 suggestRecord:false인 상태는 스펙상 존재하지 않는다.
 * 유사 사례가 없다는 것은 곧 기록할 가치가 있다는 뜻이다.
 */
export const AnswerResponse = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(true),
      answer: z.string().min(1),
      citations: z.array(Citation).min(1),
    })
    .strict(),
  z
    .object({
      found: z.literal(false),
      message: z.string().min(1),
      suggestRecord: z.literal(true),
    })
    .strict(),
]);
export type AnswerResponse = z.infer<typeof AnswerResponse>;

/** GET /health 응답. 인증 불요 (specs/04) */
export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    mongo: z.enum(["up", "down"]),
    embeddingVersion: z.number().int().nonnegative(),
    version: z.string().min(1),
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * 공통 에러 응답 `{error:{code, message, details?}}`.
 * code는 SCREAMING_SNAKE로 강제한다 (specs/04 규약) — 케이스가 섞이면
 * 클라이언트의 에러 분기가 조용히 깨진다.
 */
export const ApiError = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "code는 SCREAMING_SNAKE여야 한다"),
        message: z.string().min(1),
        details: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiError>;
