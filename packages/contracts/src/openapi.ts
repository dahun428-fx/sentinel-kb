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
  ArticleIdParam,
  HealthResponse,
  ListArticlesQuery,
  ListArticlesResponse,
  ListRecordsQuery,
  ListRecordsResponse,
  RecordIdParam,
  SearchRequest,
  SearchResponse,
} from "./api.js";
import { ArticleSchema, PatchArticleInput, PublishArticleInput } from "./article.js";
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
   * 등록 대상은 12개 오퍼레이션이 실제로 참조하는 페이로드 스키마뿐이다.
   * SearchHit·Citation·Relation·ArticleSummary·열거형처럼 그 안에 중첩된 타입은 인라인된다 —
   * 따로 등록하면 아무도 참조하지 않는 중복 컴포넌트가 생긴다.
   * chunks·feedbacks·eval_cases는 HTTP 페이로드가 아니라 저장 스키마이므로
   * Zod 스키마와 타입으로만 export하고 OpenAPI에는 싣지 않는다.
   *
   * `Article`은 B-1에서 들어왔다 — `GET /v1/articles/{id}`의 응답이 되면서 저장 스키마이자
   * HTTP 페이로드가 됐다. 여전히 싣지 않는 chunks·feedbacks와 갈린 지점이 그것이다.
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
    article: registry.register("Article", ArticleSchema),
    listArticlesResponse: registry.register("ListArticlesResponse", ListArticlesResponse),
    patchArticleInput: registry.register("PatchArticleInput", PatchArticleInput),
    publishArticleInput: registry.register("PublishArticleInput", PublishArticleInput),
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
    description:
      "응답은 summary만 담고 본문은 담지 않는다 (NFR-03). " +
      "`limit`은 계약값이 이긴다 — 생략하면 5이고 RETRIEVAL_FINAL_K는 이 경로에 쓰이지 않는다. " +
      "**`score`는 RRF 융합 점수(`Σ 1/(RRF_K + rank)`)이며 순위 결정 전용의 상대값이다 — " +
      "유사도가 아니다.** RRF_K=60에서 상한은 2/61 ≈ 0.033(두 경로 모두 1위)이므로 " +
      "백분율로 보여 주거나 절대 임계값과 비교하면 안 된다. 이 값은 같은 응답 안의 " +
      "결과끼리 비교할 때만 의미가 있다. cosine 유사도는 이 응답에 실리지 않는다.",
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

  // ------------------------------------------------------------ 아티클 (B-1, specs/04 표)

  registry.registerPath({
    method: "get",
    path: "/v1/articles",
    operationId: "listArticles",
    summary: "아티클 목록",
    description:
      "**기본은 `published`만이다.** `status=candidate|draft`를 명시해야 후보 큐가 보인다 — " +
      "필터를 빠뜨렸을 때의 결과가 안전한 쪽이어야 하고, 반대로 두면 파라미터 하나를 잊는 순간 " +
      "미발행 초안이 공개된다(specs/04, T-033 Acceptance 3). " +
      "항목은 본문 없는 요약이다 (NFR-03) — `body`·`facts`·`charts`·`lintReport`는 단건 조회로 받는다. " +
      "cursor 페이지네이션(createdAt+_id)이며 offset은 지원하지 않는다.",
    tags: ["articles"],
    security: secured,
    request: { query: ListArticlesQuery },
    responses: {
      200: {
        description: "아티클 페이지",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.listArticlesResponse } },
      },
      400: errorResponse("쿼리 파라미터 위반"),
      401: errorResponse("인증 실패"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/articles/{id}",
    operationId: "getArticle",
    summary: "아티클 단건 조회 (본문 포함)",
    tags: ["articles"],
    security: secured,
    request: { params: ArticleIdParam },
    responses: {
      200: {
        description: "아티클",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.article } },
      },
      401: errorResponse("인증 실패"),
      404: errorResponse("아티클 없음"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/articles/{id}",
    operationId: "updateArticle",
    summary: "아티클 편집",
    description:
      "`candidate`·`draft`에서만 허용한다 — 발행된 글을 조용히 고치면 독자가 본 것과 저장된 것이 " +
      "갈라진다(specs/04). `status`로 지정할 수 있는 값은 `draft`·`rejected`뿐이다: " +
      "`published`는 발행 오퍼레이션의 몫이고, 그쪽에만 시각을 찍는 코드가 있다. " +
      "`publishedAt`·`project`는 받지 않으며 보내면 400이다. " +
      "서버가 바뀐 필드로 `editHistory` 항목을 만들어 붙인다(specs/08 §2).",
    tags: ["articles"],
    security: secured,
    request: {
      params: ArticleIdParam,
      body: {
        required: true,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.patchArticleInput } },
      },
    },
    responses: {
      200: {
        description: "수정된 아티클",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.article } },
      },
      400: errorResponse("스키마 위반, 빈 패치, 또는 서버 소유 필드"),
      401: errorResponse("인증 실패"),
      404: errorResponse("아티클 없음"),
      409: errorResponse("published·rejected 아티클은 편집할 수 없다"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/articles/{id}/publish",
    operationId: "publishArticle",
    summary: "아티클 발행",
    description:
      "**`publishedAt`은 서버가 찍는다 — 클라이언트가 보내면 400이다**(specs/04). " +
      "`ArticleSchema.refine`이 `body`·`publishedAt` 없는 `published`를 거부하는데 클라이언트가 그 값을 " +
      "보내면 배치가 세 겹으로 막은 자동 발행 금지가 HTTP 표면에서 뚫린다. " +
      "바디는 **빈 객체**이며 어떤 키든 400이다. 발행은 `draft`에서만 가능하다 — " +
      "본문이 없는 `candidate`를 발행하는 것은 아무도 쓰지 않은 글을 내보내는 것이다(specs/08 §0-5, §7).",
    tags: ["articles"],
    security: secured,
    request: {
      params: ArticleIdParam,
      body: {
        required: false,
        content: { [JSON_MEDIA_TYPE]: { schema: ref.publishArticleInput } },
      },
    },
    responses: {
      200: {
        description: "발행된 아티클",
        content: { [JSON_MEDIA_TYPE]: { schema: ref.article } },
      },
      400: errorResponse("바디에 키가 있다 (`publishedAt` 포함)"),
      401: errorResponse("인증 실패"),
      404: errorResponse("아티클 없음"),
      409: errorResponse("draft가 아니거나 본문이 없다"),
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

/** specs/04 표의 12개 오퍼레이션을 담은 OpenAPI 3.1 문서를 만든다(아티클 4건은 B-1). */
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
