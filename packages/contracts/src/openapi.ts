/**
 * OpenAPI 3.1 문서 생성. 출처: specs/04-api.md
 *
 * 수기 작성 금지 — Zod 스키마가 단일 소스이고 이 파일은 그것을 옮겨 담기만 한다.
 * 생성물은 `/v1/openapi.json`으로 서빙된다.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { z } from "zod";

import {
  AnswerRequest,
  AnswerResponse,
  ApiError,
  HealthResponse,
  ListRecordsQuery,
  ListRecordsResponse,
  RecordIdParam,
  SearchRequest,
  SearchResponse,
} from "./api.js";
import { FeedbackRequest } from "./feedback.js";
import { CreateRecordInput, PatchRecordInput, RecordSchema } from "./record.js";

extendZodWithOpenApi(z);

/** 이 프로젝트가 발행하는 OpenAPI 버전. 3.0으로 내려가면 판별 유니온 표현이 손실된다. */
export const OPENAPI_VERSION = "3.1.0";

const JSON_MEDIA_TYPE = "application/json";

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // NFR-04: 모든 /v1 경로는 Bearer 키 인증. 키의 project 클레임이 쓰기 범위를 정한다.
  const bearerAuth = registry.registerComponent(
    "securitySchemes",
    "bearerAuth",
    { type: "http", scheme: "bearer" },
  );
  const secured = [{ [bearerAuth.name]: [] }];

  /**
   * `registry.register`는 refId를 붙인 **새 스키마**를 돌려준다.
   * 경로에서 원본 스키마를 그대로 쓰면 $ref 대신 본문이 통째로 인라인되고
   * components는 아무도 참조하지 않는 죽은 블록이 된다 — 반드시 반환값을 쓴다.
   *
   * 등록 대상은 8개 오퍼레이션이 실제로 참조하는 페이로드 스키마뿐이다.
   * SearchHit·Citation·Relation·열거형처럼 그 안에 중첩된 타입은 인라인된다 —
   * 따로 등록하면 아무도 참조하지 않는 중복 컴포넌트가 생긴다.
   * chunks·feedbacks·eval_cases는 HTTP 페이로드가 아니라 저장 스키마이므로
   * Zod 스키마와 타입으로만 export하고 OpenAPI에는 싣지 않는다.
   */
  const ref = {
    createRecordInput: registry.register("CreateRecordInput", CreateRecordInput),
    patchRecordInput: registry.register("PatchRecordInput", PatchRecordInput),
    record: registry.register("Record", RecordSchema),
    listRecordsResponse: registry.register("ListRecordsResponse", ListRecordsResponse),
    searchRequest: registry.register("SearchRequest", SearchRequest),
    searchResponse: registry.register("SearchResponse", SearchResponse),
    answerRequest: registry.register("AnswerRequest", AnswerRequest),
    answerResponse: registry.register("AnswerResponse", AnswerResponse),
    feedbackRequest: registry.register("FeedbackRequest", FeedbackRequest),
    healthResponse: registry.register("HealthResponse", HealthResponse),
    apiError: registry.register("ApiError", ApiError),
  };

  const errorResponse = (description: string) => ({
    description,
    content: { [JSON_MEDIA_TYPE]: { schema: ref.apiError } },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/records",
    operationId: "createRecord",
    summary: "레코드 생성",
    description:
      "project는 인증 키에서 주입되며 바디 값은 받지 않는다. 새니타이즈 통과 후 저장하고 embed job을 넣는다.",
    tags: ["records"],
    security: secured,
    request: {
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.createRecordInput } },
      },
    },
    responses: {
      201: {
        description: "생성된 레코드",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.record } },
      },
      400: errorResponse("스키마 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/records",
    operationId: "listRecords",
    summary: "레코드 목록/필터",
    description:
      "cursor 페이지네이션(createdAt+_id). offset은 지원하지 않는다. 항목은 본문 없는 요약이다 (NFR-03) — 본문은 단건 조회로 받는다.",
    tags: ["records"],
    security: secured,
    request: { query: ListRecordsQuery },
    responses: {
      200: {
        description: "레코드 페이지",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.listRecordsResponse } },
      },
      400: errorResponse("쿼리 파라미터 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/records/{id}",
    operationId: "getRecord",
    summary: "레코드 단건 조회 (본문 포함)",
    tags: ["records"],
    security: secured,
    request: { params: RecordIdParam },
    responses: {
      200: {
        description: "레코드",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.record } },
      },
      401: errorResponse("인증 실패"),
      404: errorResponse("레코드 없음"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/records/{id}",
    operationId: "updateRecord",
    summary: "레코드 수정",
    description:
      "본문 섹션이 바뀌면 재임베딩 job이 생성된다. type과 project는 수정할 수 없다.",
    tags: ["records"],
    security: secured,
    request: {
      params: RecordIdParam,
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.patchRecordInput } },
      },
    },
    responses: {
      200: {
        description: "수정된 레코드",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.record } },
      },
      400: errorResponse("스키마 위반 또는 빈 패치"),
      401: errorResponse("인증 실패"),
      403: errorResponse("다른 project 레코드에는 쓸 수 없다"),
      404: errorResponse("레코드 없음"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/search",
    operationId: "searchRecords",
    summary: "하이브리드 검색",
    description: "응답은 summary만 담고 본문은 담지 않는다 (NFR-03).",
    tags: ["search"],
    security: secured,
    request: {
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.searchRequest } },
      },
    },
    responses: {
      200: {
        description: "검색 결과",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.searchResponse } },
      },
      400: errorResponse("스키마 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/answer",
    operationId: "answerQuestion",
    summary: "RAG 생성 답변",
    description:
      "근거가 있으면 found:true + citations, 임계값 미달이면 found:false + suggestRecord:true. 근거 없는 생성은 하지 않는다 (NFR-02).",
    tags: ["answer"],
    security: secured,
    request: {
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.answerRequest } },
      },
    },
    responses: {
      200: {
        description: "인용 포함 답변 또는 found:false",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.answerResponse } },
      },
      400: errorResponse("스키마 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/feedback",
    operationId: "submitFeedback",
    summary: "검색·답변 유용성 피드백",
    tags: ["feedback"],
    security: secured,
    request: {
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.feedbackRequest } },
      },
    },
    responses: {
      204: { description: "기록됨" },
      400: errorResponse("스키마 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/health",
    operationId: "checkHealth",
    summary: "헬스체크 (인증 불요)",
    tags: ["ops"],
    security: [],
    responses: {
      200: {
        description: "서비스 상태",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.healthResponse } },
      },
    },
  });

  return registry;
}

/** specs/04 표의 8개 경로를 담은 OpenAPI 3.1 문서를 만든다. */
export function buildOpenApiDocument(): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: OPENAPI_VERSION,
    info: {
      title: "sentinel-kb API",
      version: "1.0.0",
      description:
        "AI-first 트러블슈팅 지식 보관소의 HTTP 계약. packages/contracts의 Zod 스키마에서 생성된다.",
    },
    servers: [{ url: "/" }],
  });
}
