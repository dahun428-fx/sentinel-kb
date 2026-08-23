/**
 * core-api HTTP 클라이언트. **서버 전용**이다.
 *
 * 출처: specs/01(web → core-api 내부 HTTP, DB 직접 접근 금지), specs/04(HTTP 계약).
 * 요청·응답 타입은 전부 `@sentinel/contracts`에서 가져온다 — 웹에서 재정의하지 않는다(CLAUDE.md).
 *
 * 이 모듈은 절대 클라이언트 컴포넌트에서 import하지 않는다. 아래 `assertServerOnly()`가
 * 실수로 브라우저에 실려도 즉시 터지게 만든다 — 키가 조용히 새는 것보다 낫다(NFR-04).
 */
import {
  AnswerRequest,
  AnswerResponse,
  ApiError,
  ArticleSchema,
  ListArticlesResponse,
  type PatchArticleInput,
  PatchArticleInput as PatchArticleInputSchema,
  RecordSchema,
  RecordType,
  SearchRequest,
  SearchResponse,
} from "@sentinel/contracts";

import {
  articlePublishPath,
  articleResourcePath,
  publicArticlesPath,
  publishRequestBody,
  queueArticlesPath,
  type QueueStatus,
} from "./articles";
import { readCoreApiConfig } from "./env";
import { reviveDates } from "./json-dates";

/** core-api가 돌려준 에러(또는 그에 준하는 전송 실패). code는 SCREAMING_SNAKE다(specs/04). */
export class CoreApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CoreApiError";
    this.code = code;
    this.status = status;
  }
}

function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "api-client는 서버 전용이다 — 클라이언트 번들에 실리면 API 키가 노출된다 (NFR-04).",
    );
  }
}

interface RequestOptions {
  readonly path: string;
  /** `PATCH`는 T-033에서 들어왔다 — specs/04의 `PATCH /v1/articles/:id`(편집). */
  readonly method: "GET" | "POST" | "PATCH";
  readonly body?: unknown;
}

async function callCoreApi(options: RequestOptions): Promise<unknown> {
  assertServerOnly();
  const config = readCoreApiConfig();

  const headers: Record<string, string> = {
    // 키는 서버 프로세스 안에서만 헤더로 붙는다. 응답에도, HTML에도 실리지 않는다.
    authorization: `Bearer ${config.apiKey}`,
    accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // 읽기 콘솔은 항상 최신 지식을 보여야 한다. 캐시된 검색 결과는 "고쳤는데 왜 그대로냐"를 만든다.
      cache: "no-store",
    });
  } catch (cause) {
    throw new CoreApiError(
      "CORE_API_UNREACHABLE",
      `core-api에 접속하지 못했다: ${cause instanceof Error ? cause.message : String(cause)}`,
      503,
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = ApiError.safeParse(payload);
    throw new CoreApiError(
      parsed.success ? parsed.data.error.code : "CORE_API_ERROR",
      parsed.success ? parsed.data.error.message : `core-api가 ${String(response.status)}를 돌려줬다`,
      response.status,
    );
  }

  return payload;
}

/** 검색 필터. contracts의 `SearchRequest`가 허용하는 것만 받는다. */
export interface SearchFilters {
  readonly query: string;
  readonly type?: RecordType;
  readonly project?: string;
  readonly limit?: number;
}

/** POST /v1/search — 하이브리드 검색 (specs/04, FR-03). */
export async function searchRecords(filters: SearchFilters): Promise<SearchResponse> {
  const body = SearchRequest.parse({
    query: filters.query,
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.project === undefined ? {} : { project: filters.project }),
    ...(filters.limit === undefined ? {} : { limit: filters.limit }),
  });
  const payload = await callCoreApi({ path: "/v1/search", method: "POST", body });
  return SearchResponse.parse(payload);
}

/** POST /v1/answer — 인용이 강제된 RAG 답변 (specs/04, FR-04/NFR-02). */
export async function answerQuestion(input: {
  readonly query: string;
  readonly project?: string;
}): Promise<AnswerResponse> {
  const body = AnswerRequest.parse({
    query: input.query,
    ...(input.project === undefined ? {} : { project: input.project }),
    // 웹은 완성된 답변만 렌더한다. SSE는 이 태스크 범위 밖이다(T-023 Scope).
    stream: false,
  });
  const payload = await callCoreApi({ path: "/v1/answer", method: "POST", body });
  return AnswerResponse.parse(payload);
}

/** GET /v1/records/:id — 본문 포함 단건 조회 (specs/04). */
export async function getRecord(id: string): Promise<RecordSchema> {
  const payload = await callCoreApi({
    path: `/v1/records/${encodeURIComponent(id)}`,
    method: "GET",
  });
  // contracts가 `createdAt`/`updatedAt`을 `z.date()`로 정의하므로 ISO 문자열을 되살린 뒤 파싱한다.
  return RecordSchema.parse(reviveDates(payload));
}

// ---------------------------------------------------------------- 아티클 (T-033, specs/04 표)

/**
 * GET /v1/articles — **공개 목록.** T-033 Acceptance 3의 실행 지점이다.
 *
 * `status` 인자가 없다. 필터는 서버에 있고(`ListArticlesQuery.status`의
 * `.default("published")` + `packages/api/src/articles.ts`의 무조건 필터), 웹이 할 일은
 * **상태를 고르지 않는 것**이다. 그래서 이 함수는 상태를 고를 수단 자체를 제공하지 않는다.
 * 후보를 보려면 아래 `listArticleQueue`를 **의도적으로** 불러야 한다.
 */
export async function listPublishedArticles(cursor?: string): Promise<ListArticlesResponse> {
  const payload = await callCoreApi({ path: publicArticlesPath(cursor), method: "GET" });
  return ListArticlesResponse.parse(reviveDates(payload));
}

/**
 * GET /v1/articles?status=… — **후보 큐.** specs/04: "명시해야 후보 큐가 보인다".
 * `status`가 필수 인자라 "빠뜨려서 후보가 새는" 경우가 성립하지 않는다.
 */
export async function listArticleQueue(
  status: QueueStatus,
  cursor?: string,
): Promise<ListArticlesResponse> {
  const payload = await callCoreApi({ path: queueArticlesPath(status, cursor), method: "GET" });
  return ListArticlesResponse.parse(reviveDates(payload));
}

/** GET /v1/articles/:id — 본문 포함 단건 조회 (specs/04). */
export async function getArticle(id: string): Promise<ArticleSchema> {
  const payload = await callCoreApi({ path: articleResourcePath(id), method: "GET" });
  return ArticleSchema.parse(reviveDates(payload));
}

/**
 * PATCH /v1/articles/:id — 사람 편집. 상태 게이트(candidate·draft)는 **서버가** 판정한다.
 *
 * 바디는 `PatchArticleInput`이 만든다 — `.strict()`라 `publishedAt`·`editHistory` 같은
 * 서버 소유 필드가 섞이면 **보내기 전에** 여기서 터진다. `editHistory`는 서버가 붙인다:
 * "편집 기록을 편집 요청이 쓸 수 있으면 기록이 증거가 아니게 된다"(contracts 주석).
 */
export async function patchArticle(id: string, input: PatchArticleInput): Promise<ArticleSchema> {
  const body = PatchArticleInputSchema.parse(input);
  const payload = await callCoreApi({ path: articleResourcePath(id), method: "PATCH", body });
  return ArticleSchema.parse(reviveDates(payload));
}

/**
 * POST /v1/articles/:id/publish — 발행. **사람만 누른다**(specs/08 §7).
 *
 * 바디는 `publishRequestBody()`가 만드는 빈 객체다. `publishedAt`을 여기서 보내면
 * specs/04가 400으로 거부하며, 그것이 전자동 발행 금지의 HTTP 쪽 한 겹이다.
 * 이 함수가 발행 시각을 **인자로도 받지 않는** 것이 같은 방어선의 클라이언트 쪽 한 겹이다.
 */
export async function publishArticle(id: string): Promise<ArticleSchema> {
  const payload = await callCoreApi({
    path: articlePublishPath(id),
    method: "POST",
    body: publishRequestBody(),
  });
  return ArticleSchema.parse(reviveDates(payload));
}
