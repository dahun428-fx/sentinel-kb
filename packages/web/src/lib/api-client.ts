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
  RecordSchema,
  RecordType,
  SearchRequest,
  SearchResponse,
} from "@sentinel/contracts";

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
  readonly method: "GET" | "POST";
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
