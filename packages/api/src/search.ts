/**
 * `POST /v1/search` 라우트. 출처: specs/04-api.md 표, specs/00 NFR-01·NFR-03, T-012.
 *
 * 이 파일이 하는 일은 **경계 투영**뿐이다. 검색 자체는 core의 `retrieve()`가 하고,
 * 여기서는 (a) 계약으로 입력을 검증하고, (b) core 도메인 타입 `RetrievedChunk`를
 * contracts의 `SearchHit`으로 낮추고, (c) NFR-01을 판정할 수 있는 로그를 남긴다.
 *
 * ## `SearchHit.score`에 무엇을 싣는가 — `fusedScore`(RRF)다
 *
 * `RetrievedChunk`는 점수를 셋으로 쪼갠다. 그중 **`fusedScore`만이 항상 존재한다**:
 *  - `vectorScore`(원시 cosine −1..1)는 텍스트 경로에서만 온 hit이면 `null`,
 *  - `textScore`(BM25, 무제한)는 벡터 경로에서만 온 hit이면 `null`인데,
 *  - `SearchHit.score`는 `z.number()`라 **nullable이 아니다**(contracts).
 * null을 0으로 접으면 "벡터 경로가 없었다"와 "직교한다(cosine 0)"가 같은 값이 되어
 * 클라이언트가 구별할 수 없다 — retriever가 `maxVectorScore`에서 굳이 갈라 둔 그 구별이다.
 *
 * 더 결정적으로, 응답의 **정렬 순서를 실제로 만든 값**이 `fusedScore`다. 다른 값을 실으면
 * 순서와 점수가 어긋나 "3위가 1위보다 점수가 높은" 목록이 나온다.
 *
 * 대가는 척도가 사람에게 무의미하다는 것이다: `RRF_K=60`에서 상한이 `2/61 ≈ 0.0328`이라
 * MCP 도구(T-015)가 이 값을 그대로 보여 주면 "일치도 0.03"으로 읽힌다. 그래서
 * **openapi description에 척도를 명시**했고(=`buildOpenApiDocument`), 이 주석이 그 근거다.
 * 유사도로 읽히는 값이 필요하면 그것은 `vectorScore`이고, `SearchHit`에는 자리가 없다
 * (T-018/T-019가 쓴다). 자리를 만드는 것은 contracts 개정이라 인간 승인 사항이다.
 *
 * ## 쿼리를 새니타이즈하지 않는다 (T-007 R-2)
 *
 * `sanitize()`는 **저장되는 텍스트**를 마스킹하는 게이트다. 검색 쿼리는 저장되지 않고,
 * 마스킹하면 `api_key=` 같은 토큰을 찾으려는 질의가 `[MASKED:api-key]` 질의로 **조용히
 * 바뀌어** 다른 결과를 낸다 — 검색은 입력을 그대로 해석해야 하는 읽기 경로다.
 * 길이 상한도 여기서 다시 걸지 않는다: 상한 초과는 413 `SANITIZE_INPUT_TOO_LARGE`로 나가는데
 * 그 코드는 openapi의 `/v1/search` 응답에 등재돼 있지 않아, 새니타이즈를 켜는 순간
 * **문서에 없는 상태 코드**가 이 경로에서 나온다. 과대 입력은 Fastify의 바디 상한이 막는다.
 */
import { SearchHit, SearchRequest, SearchResponse } from "@sentinel/contracts";
import {
  RETRIEVER_ERROR_CODES,
  RetrieverError,
  type RetrievalResult,
  type Retriever,
  type RetrievedChunk,
} from "@sentinel/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { API_ERROR_CODES, HttpError } from "./errors.js";

export interface SearchRoutesDeps {
  readonly retriever: Retriever;
  /**
   * 단조 증가 시계(ms). 지연 측정 전용이라 `now: () => Date`(벽시계)와 **다른 의존**이다 —
   * 벽시계는 NTP 보정으로 뒤로 갈 수 있고 그러면 음수 지연이 로그에 박힌다.
   * 테스트가 결정론적 값을 넣는 지점이기도 하다.
   */
  readonly monotonicNowMs?: () => number;
}

/** 로그 1줄의 `event` 값. 로그 수집기가 이 문자열로 검색 요청만 골라낸다. */
export const SEARCH_LOG_EVENT = "search";

/** 로그 1줄의 `route` 값. 경로가 늘어나도 같은 필드로 집계할 수 있게 문자열로 박는다. */
export const SEARCH_ROUTE = "POST /v1/search";

/**
 * 검색 1회의 계측 필드. **`totalMs`가 NFR-01(검색 API p95 < 1.5s)의 판정 대상**이다.
 *
 * `retrievalMs`를 따로 남기는 이유는 p95가 깨졌을 때 "검색이 느린가, 투영·직렬화가 느린가"를
 * 로그만으로 가르기 위함이다. 둘의 차이가 곧 라우트 오버헤드다.
 *
 * ## 벡터·텍스트 경로를 나눠 재지 **않는다** (T-011 F-2 인계 판단)
 * `retrieve()`는 두 경로를 `Promise.all`로 한 번에 돌리고 `RetrievalResult`에는 경로별
 * 소요 시간이 **없다**. 여기서 나눠 재려면 core의 반환 타입을 넓혀야 하는데 그것은
 * T-011 산출물 수정이라 이 태스크 범위 밖이다. 대신 진단에 필요한 값을 최대한 남긴다:
 * `vectorCandidateCount`·`textCandidateCount`가 0이면 그 경로는 기여하지 않은 것이다.
 * **다만 이 두 값은 `$limit` 이후 수치라 F-2가 경고한 "mongot이 매칭 전체를 흘리는" 상태를
 * 드러내지 못한다** — 그 판정에는 경로별 시간이 필요하다(Findings에 인계).
 */
export interface SearchLogFields {
  readonly event: typeof SEARCH_LOG_EVENT;
  readonly route: typeof SEARCH_ROUTE;
  readonly outcome: "ok" | "error";
  /** 호출 키의 project 클레임. 레이트리밋·이상 탐지의 그룹 키다. */
  readonly project: string;
  /** 요청이 건 필터. 안 걸었으면 null이다 — 필터 유무로 지연을 갈라 보기 위한 것이다. */
  readonly filterType: string | null;
  readonly filterProject: string | null;
  /** 바디가 검증을 통과하기 전이면 숫자가 아닐 수 있다 — 그때는 null이다(센티널 금지). */
  readonly limit: number | null;
  /**
   * 쿼리 **길이만** 남긴다. 원문을 로그에 남기면 사용자가 붙여 넣은 시크릿·PII가
   * 로그 수집기로 흘러가고, 그건 새니타이저가 저장 경로에서 막고 있는 바로 그 유출이다.
   *
   * `query`가 문자열이 아니었으면 null이다.
   */
  readonly queryChars: number | null;
  readonly hitCount: number | null;
  readonly vectorCandidateCount: number | null;
  readonly textCandidateCount: number | null;
  /**
   * 융합 전 원시 cosine 최고점(−1..1). 벡터 경로 0건이면 null.
   * **T-013이 `SIMILARITY_THRESHOLD`를 스윕할 때 이 로그가 실측 분포의 원천이다.**
   */
  readonly maxVectorScore: number | null;
  readonly retrievalMs: number | null;
  /** 핸들러 전체 소요. NFR-01 p95는 이 필드로 계산한다. */
  readonly totalMs: number;
  /** 실패했을 때의 에러 코드. 성공이면 null이다. */
  readonly errorCode: string | null;
}

/** 0.1ms 해상도. 소수점이 길어지면 로그만 커지고 p95는 달라지지 않는다. */
function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface BuildSearchLogInput {
  readonly outcome: "ok" | "error";
  readonly project: string;
  readonly filterType?: string | undefined;
  readonly filterProject?: string | undefined;
  readonly limit: number | null;
  readonly queryChars: number | null;
  readonly result?: RetrievalResult | undefined;
  readonly retrievalMs?: number | undefined;
  readonly totalMs: number;
  readonly errorCode?: string | undefined;
}

/**
 * 로그 필드를 만든다. **순수 함수다** — 라우트 안에 인라인하면 필드 하나가 빠져도
 * 아무 테스트도 깨지지 않는다. p95를 못 재는 로그는 없는 로그와 같으므로 여기서 잠근다.
 */
export function buildSearchLogFields(input: BuildSearchLogInput): SearchLogFields {
  return {
    event: SEARCH_LOG_EVENT,
    route: SEARCH_ROUTE,
    outcome: input.outcome,
    project: input.project,
    filterType: input.filterType ?? null,
    filterProject: input.filterProject ?? null,
    limit: input.limit,
    queryChars: input.queryChars,
    hitCount: input.result === undefined ? null : input.result.hits.length,
    vectorCandidateCount: input.result?.vectorCandidateCount ?? null,
    textCandidateCount: input.result?.textCandidateCount ?? null,
    maxVectorScore: input.result?.maxVectorScore ?? null,
    retrievalMs: input.retrievalMs === undefined ? null : roundMs(input.retrievalMs),
    totalMs: roundMs(input.totalMs),
    errorCode: input.errorCode ?? null,
  };
}

/**
 * `RetrievedChunk` → `SearchHit`.
 *
 * **필드를 하나씩 적는다. 스프레드하지 않는다.** 스프레드하면 `text`(청크 본문)가 딸려
 * 들어가 NFR-03을 즉시 위반한다. `SearchHit`이 `.strict()`라 그 경우 파싱이 실패하는데,
 * 그 실패가 방어선이지 우회 대상이 아니다 — 여기서 `.parse()`를 거치는 이유가 그것이다.
 * (`seq`·`chunkId`·`vectorRank` 등 나머지 청크 필드도 같은 이유로 자리가 없다.)
 */
export function toSearchHit(chunk: RetrievedChunk): SearchHit {
  return SearchHit.parse({
    recordId: chunk.recordId,
    title: chunk.title,
    /** record의 요약이다. 청크 본문이 아니다 — 청크 텍스트에는 `[제목] (섹션)` prefix가 붙어 있다. */
    summary: chunk.summary,
    section: chunk.section,
    /** 위 파일 주석 참조: 순위를 실제로 만든 값이자 항상 존재하는 유일한 점수다. */
    score: chunk.fusedScore,
    type: chunk.type,
    project: chunk.project,
    flags: chunk.flags,
  });
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRoutesDeps): void {
  const nowMs = deps.monotonicNowMs ?? ((): number => performance.now());

  app.post("/v1/search", async (request, reply): Promise<FastifyReply> => {
    const startedAt = nowMs();

    const parsed = SearchRequest.safeParse(request.body);
    if (!parsed.success) {
      /*
       * 검증 실패도 로그를 남긴다. 400만 골라 조용히 넘기면 "느린 요청은 전부 성공한
       * 요청"이라는 편향이 생겨 p95가 실제보다 낙관적으로 보인다.
       */
      request.log.info(
        buildSearchLogFields({
          outcome: "error",
          project: request.project,
          limit: readNumber(request.body, "limit"),
          queryChars: readLength(request.body, "query"),
          totalMs: nowMs() - startedAt,
          errorCode: API_ERROR_CODES.VALIDATION_FAILED,
        }),
        SEARCH_LOG_EVENT,
      );
      throw new HttpError(
        400,
        API_ERROR_CODES.VALIDATION_FAILED,
        "검색 요청이 스키마를 만족하지 않는다. limit은 1–20, query는 2자 이상이다.",
        parsed.error.issues,
      );
    }
    const input = parsed.data;

    const retrievalStartedAt = nowMs();
    let result: RetrievalResult;
    try {
      result = await deps.retriever.retrieve({
        query: input.query,
        /*
         * **`SearchRequest.limit`이 이긴다.** Zod의 `.default(5)`가 이미 적용된 뒤라
         * 이 값은 항상 정의돼 있고, 그래서 `RETRIEVAL_FINAL_K`(기본 8)는 여기서 절대
         * 쓰이지 않는다. 그쪽은 **호출자가 수를 말하지 않을 때의 파이프라인 기본값**
         * (eval 스윕·T-018 생성 경로)이고, 이쪽은 **클라이언트에게 한 약속**이다.
         * FINAL_K가 이기면 계약의 `max(20)`·`default(5)`가 거짓말이 되고,
         * "limit>20이면 400"이라는 Acceptance도 의미를 잃는다.
         */
        limit: input.limit,
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.project === undefined ? {} : { project: input.project }),
      });
    } catch (error) {
      const code = error instanceof RetrieverError ? error.code : "UNKNOWN";
      request.log.info(
        buildSearchLogFields({
          outcome: "error",
          project: request.project,
          filterType: input.type,
          filterProject: input.project,
          limit: input.limit,
          queryChars: input.query.length,
          retrievalMs: nowMs() - retrievalStartedAt,
          totalMs: nowMs() - startedAt,
          errorCode: code,
        }),
        SEARCH_LOG_EVENT,
      );

      /*
       * 공백만 있는 쿼리는 `min(2)`를 통과하지만 retriever가 trim 후 거부한다.
       * 그건 **클라이언트 입력 문제**이므로 500이 아니라 400으로 옮긴다.
       * 나머지 코드(후보 스키마 위반·질의 벡터 차원 불일치)는 데이터·설정 결함이라
       * 그대로 던져 에러 핸들러의 500으로 보낸다 — 클라이언트가 고칠 수 있는 게 없다.
       */
      if (error instanceof RetrieverError && error.code === RETRIEVER_ERROR_CODES.QUERY_EMPTY) {
        throw new HttpError(
          400,
          API_ERROR_CODES.VALIDATION_FAILED,
          "검색 쿼리가 공백뿐이다. 공백을 제거하면 빈 문자열이 된다.",
        );
      }
      throw error;
    }
    const retrievalMs = nowMs() - retrievalStartedAt;

    /**
     * `SearchResponse`도 `.strict()`다. 여기서 한 번 더 파싱하는 것은 중복이 아니라
     * **응답 형상의 마지막 게이트**다 — hit 투영이 통과해도 래퍼에 필드가 붙으면 여기서 죽는다.
     *
     * **이 파싱 실패도 로그를 남긴다.** 예전에는 try 밖에 있어서 여기서 던지면
     * `event:"search"` 줄이 아예 안 나갔다 — 500이 p95 모집단에서 조용히 사라지는 방향이라,
     * 실패를 일부러 로깅한 이 설계의 취지와 정면으로 어긋난다.
     */
    let body;
    try {
      body = SearchResponse.parse({ results: result.hits.map(toSearchHit) });
    } catch (error) {
      request.log.info(
        buildSearchLogFields({
          outcome: "error",
          project: request.project,
          filterType: input.type,
          filterProject: input.project,
          limit: input.limit,
          queryChars: input.query.length,
          retrievalMs,
          totalMs: nowMs() - startedAt,
          errorCode: "RESPONSE_SHAPE_INVALID",
        }),
        SEARCH_LOG_EVENT,
      );
      throw error;
    }

    request.log.info(
      buildSearchLogFields({
        outcome: "ok",
        project: request.project,
        filterType: input.type,
        filterProject: input.project,
        limit: input.limit,
        queryChars: input.query.length,
        result,
        retrievalMs,
        totalMs: nowMs() - startedAt,
      }),
      SEARCH_LOG_EVENT,
    );

    return reply.send(body);
  });
}

/**
 * 검증 실패 로그용. 파싱 전 바디라 형상을 신뢰할 수 없으므로 방어적으로 읽는다.
 *
 * **`-1` 같은 센티널을 쓰지 않는다.** "limit이 숫자가 아니었다"를 `-1`로 접으면
 * 집계에서 진짜 값과 섞여 평균·분위수를 오염시킨다. 이 파일이 `maxVectorScore`에 대해
 * 스스로 지킨 원칙("0점"과 "판정 불가"는 다르다)과 같은 종류다 — `null`로 남긴다.
 */
function readNumber(body: unknown, key: string): number | null {
  const value = pick(body, key);
  return typeof value === "number" ? value : null;
}

function readLength(body: unknown, key: string): number | null {
  const value = pick(body, key);
  return typeof value === "string" ? value.length : null;
}

function pick(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}
