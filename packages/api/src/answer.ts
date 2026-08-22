/**
 * `POST /v1/answer` 라우트. 출처: specs/04-api.md 표, specs/03 §4, NFR-01·NFR-02·NFR-05, T-019.
 *
 * `search.ts`와 같은 규약이다 — 이 파일은 **경계 투영과 계측**만 한다. 검색은 core의
 * `retrieve()`, 생성과 **임계값 게이트**는 core의 `generateAnswer()`가 한다.
 *
 * ## 게이트는 스트림 시작 **앞**에 있다 (T-018 F-2가 넘긴 계약)
 *
 * T-018은 "임계값 미달이면 모델 호출이 **아예 발생하지 않는다**"를 스파이로 잠갔다.
 * SSE에서 헤더를 먼저 흘려보낸 뒤 게이트에 걸리면 `found:false`를 SSE 프레임으로 표현해야
 * 하고, 그 순간 그 보장이 **HTTP 표면에서 되돌려진다**(스트림이 이미 열렸으므로 클라이언트는
 * "생성이 시작됐다"를 관측한다). 그래서 순서가 계약이다:
 *
 *   1. `generateAnswer()`를 **끝까지** 돌린다 — 게이트가 여기 안에 있고, 미달이면 모델을 안 부른다.
 *   2. `found:false`면 **SSE를 시작하지 않는다.** `stream:true`로 요청했어도 JSON으로 답한다.
 *   3. `found:true`일 때만, 그리고 그때만 `text/event-stream` 헤더가 나간다.
 *
 * 즉 **SSE 스트림은 오직 found:true만 실어 나른다.** `stream` 플래그는 "답이 있으면 흘려 달라"는
 * 뜻이지 "무슨 일이 있어도 스트림을 열어 달라"가 아니다. 계약(`AnswerResponse`)이 두 갈래를
 * 모두 JSON으로 정의하고 있으므로, 미달 갈래를 JSON으로 내는 것은 계약 위반이 아니다 —
 * 오히려 SSE 프레임으로 `found:false`를 새로 발명하는 쪽이 계약에 없는 표면을 만든다.
 *
 * ## 게이트를 여기서 **다시 판정하지 않는다** (T-015 F-4)
 *
 * `evaluateThresholdGate`는 `generateAnswer` 안에서만 불린다. 라우트가 `maxVectorScore`를
 * 한 번 더 보고 자기 판단을 얹으면 게이트가 두 곳이 되어 갈라지고, MCP `suggest_resolution`이
 * 그랬듯 **금지된 척도 비교**(RRF vs cosine)가 슬그머니 들어온다. 여기서는 `result.found`만 본다.
 *
 * ## 진짜 토큰 스트리밍이 아니다 — 알고 그렇게 했다
 *
 * `ChatModel.complete()`는 완성된 텍스트 하나를 돌려준다(T-018 D-2). 즉 아래 SSE는
 * **완성된 답변을 청크로 나눠 프레이밍**하는 것이지 모델 토큰을 실시간으로 흘리는 것이 아니다.
 * 지금 실 provider가 없으므로 어느 쪽이든 관측 가능한 차이가 없고, `ChatModel`에 스트리밍
 * 메서드를 더하는 것은 `packages/core` 수정이라 T-019의 Context budget 밖이다.
 * 실 provider를 붙이는 태스크가 `stream()`을 더하면 이 파일에서 바뀌는 곳은
 * `streamAnswer`의 청크 공급원 한 군데뿐이다 — 게이트 순서는 그대로 유지된다(Findings).
 */
import { AnswerRequest, AnswerResponse, Citation } from "@sentinel/contracts";
import {
  buildGateLogFields,
  generateAnswer,
  RETRIEVER_ERROR_CODES,
  RetrieverError,
  type ChatModel,
  type GateLogFields,
  type GenerateResult,
  type GeneratorConfig,
  type RetrievalResult,
  type Retriever,
  type RetrievedChunk,
} from "@sentinel/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { API_ERROR_CODES, HttpError } from "./errors.js";

export interface AnswerRoutesDeps {
  readonly retriever: Retriever;
  /**
   * 생성에 쓸 모델. **주면 라우트가 뜨고 안 주면 뜨지 않는다**(`retriever`와 같은 규약).
   * 실 provider가 아직 없으므로(T-018 D-2) 프로덕션 컴포지션 루트는 아직 이 값을 만들지
   * 못한다 — `server.ts` 주석 참조.
   */
  readonly chatModel: ChatModel;
  /** 미지정이면 env에서 읽는다(`SIMILARITY_THRESHOLD`·`ANSWER_MAX_TOKENS`). eval이 흔드는 지점. */
  readonly generatorConfig?: GeneratorConfig;
  /** `search.ts`와 같은 이유로 단조 시계다 — 벽시계는 NTP 보정으로 뒤로 갈 수 있다. */
  readonly monotonicNowMs?: () => number;
}

/** 로그 1줄의 `event` 값. 수집기가 이 문자열로 생성 요청만 골라낸다. */
export const ANSWER_LOG_EVENT = "answer";

/** 로그 1줄의 `route` 값. `SEARCH_ROUTE`와 같은 규약이다. */
export const ANSWER_ROUTE = "POST /v1/answer";

/** SSE 응답의 content-type. 이 값이 나갔다는 것은 곧 "스트림을 시작했다"는 뜻이다. */
export const SSE_CONTENT_TYPE = "text/event-stream";

/**
 * SSE 이벤트 이름. **`done`은 종료 신호이자 인용 목록의 전달 수단**이다.
 * 답변 본문은 `chunk` 이벤트를 순서대로 이어 붙인 것과 같다(테스트가 잠근다).
 */
export const SSE_EVENTS = {
  CHUNK: "chunk",
  DONE: "done",
} as const;

/**
 * SSE 청크 1개의 문자 수.
 *
 * 튜닝 파라미터가 아니라 **전송 프레이밍 상수**라 env로 빼지 않는다(specs/03 §6의 대상은
 * 검색·생성 품질 파라미터다). 값의 근거는 "완료 이벤트 하나로 끝나는 응답이 아님을
 * 관측 가능하게 만드는 최소 단위"이고, 답변이 이보다 짧으면 청크는 1개가 된다.
 */
export const ANSWER_CHUNK_CHARS = 160;

/**
 * 생성 1회의 계측 필드. **`totalMs`가 NFR-01 판정 대상**이다(MCP 도구 p95 < 2s의 하류).
 *
 * `search.ts`의 `SearchLogFields`와 같은 규약으로 **순수 함수**가 만든다 — 라우트에
 * 인라인하면 필드 하나가 빠져도 아무 테스트도 깨지지 않고, 못 재는 로그는 없는 로그와 같다.
 *
 * 게이트 필드는 `buildGateLogFields`(core)가 만든 것을 **그대로 편다**. 이름을 여기서 다시
 * 지으면 T-013의 임계값 스윕이 로그를 가로질러 집계할 수 없다(T-018 F-6).
 * **`gatePassed`와 `gateThresholdEvaluated`는 별개 필드다** — 판정 불가(`not-evaluable`)는
 * `gatePassed:true, gateThresholdEvaluated:false`이고, 둘을 합치면 스윕 곡선이 오염된다.
 */
export interface AnswerLogFields extends Partial<GateLogFields> {
  readonly event: typeof ANSWER_LOG_EVENT;
  readonly route: typeof ANSWER_ROUTE;
  readonly outcome: "ok" | "error";
  readonly project: string;
  readonly filterProject: string | null;
  /** 요청이 SSE를 원했는가. 실제로 열었는지는 `streamed`가 말한다. */
  readonly stream: boolean | null;
  /** **실제로 `text/event-stream`을 시작했는가.** `found:false`면 언제나 false다. */
  readonly streamed: boolean;
  /**
   * 쿼리 **길이만** 남긴다. 원문을 남기면 사용자가 붙여 넣은 시크릿·PII가 로그 수집기로
   * 흘러가고, 그건 새니타이저가 저장 경로에서 막고 있는 바로 그 유출이다(`search.ts` 규약).
   */
  readonly queryChars: number | null;
  readonly found: boolean | null;
  /** `found:false`의 사유(`below-threshold`·`no-usable-context`). 성공이면 null. */
  readonly skipReason: string | null;
  readonly hitCount: number | null;
  readonly citationCount: number | null;
  /**
   * `injection-suspect`로 컨텍스트에서 빠진 청크 수(T-018 F-7이 요청한 관측 지점).
   * 이 수가 갑자기 늘면 새 오염 유입이거나 새니타이저 오탐 증가다.
   */
  readonly excludedChunkCount: number | null;
  /** 답변 **길이만** 남긴다. 본문은 로그에 싣지 않는다 — 쿼리와 같은 이유다. */
  readonly answerChars: number | null;
  readonly model: string | null;
  readonly retrievalMs: number | null;
  readonly generationMs: number | null;
  readonly totalMs: number;
  readonly errorCode: string | null;
}

/** 0.1ms 해상도. `search.ts`와 같다 — 소수점이 길어지면 로그만 커진다. */
function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface BuildAnswerLogInput {
  readonly outcome: "ok" | "error";
  readonly project: string;
  readonly filterProject?: string | undefined;
  readonly stream: boolean | null;
  readonly streamed?: boolean;
  readonly queryChars: number | null;
  readonly retrieval?: RetrievalResult | undefined;
  readonly result?: GenerateResult | undefined;
  readonly citationCount?: number | undefined;
  readonly retrievalMs?: number | undefined;
  readonly generationMs?: number | undefined;
  readonly totalMs: number;
  readonly errorCode?: string | undefined;
}

export function buildAnswerLogFields(input: BuildAnswerLogInput): AnswerLogFields {
  const result = input.result;
  const base: AnswerLogFields = {
    event: ANSWER_LOG_EVENT,
    route: ANSWER_ROUTE,
    outcome: input.outcome,
    project: input.project,
    filterProject: input.filterProject ?? null,
    stream: input.stream,
    streamed: input.streamed ?? false,
    queryChars: input.queryChars,
    found: result === undefined ? null : result.found,
    skipReason: result === undefined || result.found ? null : result.skipReason,
    hitCount: input.retrieval === undefined ? null : input.retrieval.hits.length,
    citationCount: input.citationCount ?? null,
    excludedChunkCount: result === undefined ? null : result.excluded.length,
    answerChars: result === undefined || !result.found ? null : result.answer.length,
    model: result === undefined || !result.found ? null : result.model,
    retrievalMs: input.retrievalMs === undefined ? null : roundMs(input.retrievalMs),
    generationMs: input.generationMs === undefined ? null : roundMs(input.generationMs),
    totalMs: roundMs(input.totalMs),
    errorCode: input.errorCode ?? null,
  };

  // 게이트가 판정되기 전에 실패한 요청(검증 실패·검색 실패)에는 게이트 필드가 아예 없다.
  // 0이나 false로 채우지 않는다 — "판정하지 않았다"를 "미달"로 접는 것이 감사 B-1이
  // 막으려던 종류의 오류다(`search.ts`가 `-1` 센티널을 거부한 것과 같은 원칙).
  return result === undefined ? base : { ...base, ...buildGateLogFields(result.gate) };
}

/**
 * 컨텍스트에 실린 청크 → `Citation`.
 *
 * **필드를 하나씩 적는다. 스프레드하지 않는다.** 스프레드하면 `text`(청크 본문)가 딸려 들어가
 * NFR-03을 즉시 위반한다(T-011 F-E, T-018 F-3). `Citation`이 `.strict()`라 그 경우 파싱이
 * 실패하는데, 그 실패가 방어선이지 우회 대상이 아니다.
 *
 * `score`는 `fusedScore`(RRF)다. `SearchHit.score`와 같은 이유로 — 순위를 실제로 만든 값이자
 * 항상 존재하는 유일한 점수다(`vectorScore`는 텍스트 단독 hit에서 null인데 계약은 nullable이
 * 아니다). **절대 해석하지 마라**: `Σ 1/(RRF_K+rank)` 척도라 상한이 약 0.033이고,
 * 백분율 환산이나 임계값 비교는 둘 다 틀린다(T-012 F-B, specs/03:62).
 */
export function toCitation(chunk: RetrievedChunk): Citation {
  return Citation.parse({
    recordId: chunk.recordId,
    section: chunk.section,
    title: chunk.title,
    score: chunk.fusedScore,
  });
}

/**
 * `FoundResult.contextChunkIds`가 지목한 청크만 골라 인용으로 낮춘다.
 *
 * 인용의 진실 집합은 **컨텍스트에 실제로 들어간 청크**다 — `injection-suspect`로 제외된
 * 것은 여기 없다(T-018 F-4). 검색 hit 전체를 그대로 인용으로 내보내면 제외된 레코드가
 * 인용으로 되살아나 T-018의 제외가 HTTP 표면에서 무효가 된다.
 */
export function toCitations(hits: readonly RetrievedChunk[], contextChunkIds: readonly string[]): Citation[] {
  const inContext = new Set(contextChunkIds);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const hit of hits) {
    if (!inContext.has(hit.chunkId)) continue;
    // 같은 레코드의 같은 섹션이 여러 청크로 쪼개져 있으면 인용은 한 줄이면 된다.
    const key = `${hit.recordId}#${hit.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(toCitation(hit));
  }
  return citations;
}

/**
 * 생성 결과 + 인용 → 응답 본문. **응답 형상의 마지막 게이트이자 NFR-02의 마지막 방어선이다.**
 *
 * `AnswerResponse`의 found:true 갈래는 `citations.min(1)`이라 **인용 없는 답변은 여기서
 * 죽는다**(FR-04·NFR-02). 라우트에 인라인하지 않고 순수 함수로 빼 둔 이유가 그것이다 —
 * 인라인이면 이 갈래가 현재 도달 불가능(생성기는 컨텍스트가 비면 답을 만들지 않는다)이라
 * **아무 테스트도 이 방어선을 관측하지 못하고**, 다음 사람이 `.parse`를 지워도 초록이다.
 * 실제로 뮤테이션으로 확인했다: 인라인 상태에서 `.parse`를 지우면 15개 통합 테스트가
 * 전부 통과했다. 여기 있으면 단위 테스트가 직접 그 상태를 만들어 죽인다.
 *
 * ⚠️ **문장 단위 인용 검증은 여기서 하지 않는다.** 주장 문장마다 유효한 `[REC-...#...]`이
 * 붙어 있는지는 `specs/03 §5`이고 T-020의 몫이다(T-019 Out of scope). 지금 이 함수가
 * 잠그는 것은 "응답에 인용이 하나라도 있는가"뿐이며, **인용이 하나도 박히지 않은 답변
 * 문장은 그대로 통과한다** — 실측으로 확인했고 Findings에 인계했다.
 */
export function toAnswerBody(
  result: GenerateResult,
  citations: readonly Citation[],
): AnswerResponse {
  return result.found
    ? AnswerResponse.parse({ found: true, answer: result.answer, citations })
    : AnswerResponse.parse({ found: false, message: result.message, suggestRecord: true });
}

/** 답변 본문을 SSE 청크로 나눈다. 코드포인트 단위 — 서로게이트 쌍을 반토막 내지 않는다. */
export function splitAnswerChunks(answer: string, size: number = ANSWER_CHUNK_CHARS): string[] {
  const chars = Array.from(answer);
  if (chars.length === 0) return [];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks;
}

/** SSE 프레임 1개. `data`는 **언제나 JSON**이다 — 본문의 개행이 프레임을 끊지 못하게 한다. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerAnswerRoutes(app: FastifyInstance, deps: AnswerRoutesDeps): void {
  const nowMs = deps.monotonicNowMs ?? ((): number => performance.now());

  app.post("/v1/answer", async (request, reply): Promise<FastifyReply> => {
    const startedAt = nowMs();

    const parsed = AnswerRequest.safeParse(request.body);
    if (!parsed.success) {
      request.log.info(
        buildAnswerLogFields({
          outcome: "error",
          project: request.project,
          stream: readBoolean(request.body, "stream"),
          queryChars: readLength(request.body, "query"),
          totalMs: nowMs() - startedAt,
          errorCode: API_ERROR_CODES.VALIDATION_FAILED,
        }),
        ANSWER_LOG_EVENT,
      );
      throw new HttpError(
        400,
        API_ERROR_CODES.VALIDATION_FAILED,
        "답변 요청이 스키마를 만족하지 않는다. query는 2자 이상이고 stream은 boolean이다.",
        parsed.error.issues,
      );
    }
    const input = parsed.data;

    const retrievalStartedAt = nowMs();
    let retrieval: RetrievalResult;
    try {
      retrieval = await deps.retriever.retrieve({
        query: input.query,
        ...(input.project === undefined ? {} : { project: input.project }),
      });
    } catch (error) {
      const code = error instanceof RetrieverError ? error.code : "UNKNOWN";
      request.log.info(
        buildAnswerLogFields({
          outcome: "error",
          project: request.project,
          filterProject: input.project,
          stream: input.stream,
          queryChars: input.query.length,
          retrievalMs: nowMs() - retrievalStartedAt,
          totalMs: nowMs() - startedAt,
          errorCode: code,
        }),
        ANSWER_LOG_EVENT,
      );
      // `search.ts`와 같은 판단: 공백뿐인 쿼리는 클라이언트 입력 문제라 400으로 옮긴다.
      if (error instanceof RetrieverError && error.code === RETRIEVER_ERROR_CODES.QUERY_EMPTY) {
        throw new HttpError(
          400,
          API_ERROR_CODES.VALIDATION_FAILED,
          "질의가 공백뿐이다. 공백을 제거하면 빈 문자열이 된다.",
        );
      }
      throw error;
    }
    const retrievalMs = nowMs() - retrievalStartedAt;

    /*
     * **여기가 게이트다.** `generateAnswer`가 임계값을 판정하고, 미달이면 `model.complete`를
     * 부르지 않은 채 `found:false`로 돌아온다. 이 호출이 끝나기 전에는 응답 헤더가 한 바이트도
     * 나가지 않는다 — 그것이 T-018 F-2가 요구한 순서다.
     */
    const generationStartedAt = nowMs();
    let result: GenerateResult;
    try {
      result = await generateAnswer({
        query: input.query,
        retrieval,
        model: deps.chatModel,
        ...(deps.generatorConfig === undefined ? {} : { config: deps.generatorConfig }),
      });
    } catch (error) {
      request.log.info(
        buildAnswerLogFields({
          outcome: "error",
          project: request.project,
          filterProject: input.project,
          stream: input.stream,
          queryChars: input.query.length,
          retrieval,
          retrievalMs,
          generationMs: nowMs() - generationStartedAt,
          totalMs: nowMs() - startedAt,
          errorCode: errorCodeOf(error),
        }),
        ANSWER_LOG_EVENT,
      );
      throw error;
    }
    const generationMs = nowMs() - generationStartedAt;

    const citations = result.found ? toCitations(retrieval.hits, result.contextChunkIds) : [];

    /*
     * **응답 형상의 마지막 게이트.** `AnswerResponse`의 found:true 갈래는 `citations.min(1)`이라
     * 근거 없는 답변은 스키마에서 죽는다(FR-04, NFR-02). 투영이 인용을 전부 흘려버린 경우
     * (예: contextChunkIds와 hits의 대응이 깨진 경우)가 정확히 그 갈래로 떨어진다 —
     * 그때 답변만 내보내면 "인용 없는 답"이 계약을 우회해 나간다. 파싱 실패는 방어선이다.
     */
    let body: AnswerResponse;
    try {
      body = toAnswerBody(result, citations);
    } catch (error) {
      request.log.info(
        buildAnswerLogFields({
          outcome: "error",
          project: request.project,
          filterProject: input.project,
          stream: input.stream,
          queryChars: input.query.length,
          retrieval,
          result,
          citationCount: citations.length,
          retrievalMs,
          generationMs,
          totalMs: nowMs() - startedAt,
          errorCode: "RESPONSE_SHAPE_INVALID",
        }),
        ANSWER_LOG_EVENT,
      );
      throw error;
    }

    /*
     * **`found:false`면 스트림을 시작하지 않는다.** `stream:true`로 왔어도 JSON이다.
     * 여기가 T-018 F-2의 계약이 코드로 나타나는 지점이고, 통합 테스트가
     * "미달 요청에서 text/event-stream 헤더가 나가지 않는다"로 잠근다.
     */
    const streamed = body.found && input.stream;

    request.log.info(
      buildAnswerLogFields({
        outcome: "ok",
        project: request.project,
        filterProject: input.project,
        stream: input.stream,
        streamed,
        queryChars: input.query.length,
        retrieval,
        result,
        citationCount: citations.length,
        retrievalMs,
        generationMs,
        totalMs: nowMs() - startedAt,
      }),
      ANSWER_LOG_EVENT,
    );

    if (!body.found || !input.stream) return reply.send(body);
    return sendSse(reply, body);
  });
}

/**
 * found:true 응답을 SSE로 흘린다.
 *
 * `X-Accel-Buffering: no`를 명시적으로 싣는다. specs/06의 nginx 블록은 `/mcp`에만
 * `proxy_buffering off`를 걸어 두었고 `/v1`에는 걸려 있지 않다 — 그 상태로 배포하면
 * 시드 INC-06(nginx가 SSE를 버퍼링해 스트리밍이 죽은 사건)이 이 경로에서 그대로 재현된다.
 * 이 헤더는 nginx가 **응답 단위로** 버퍼링을 끄게 하므로 conf 수정 없이도 방어선이 하나 선다.
 * 다만 이것으로 충분하지 않다(read timeout·다른 프록시) — conf 쪽은 T-026에 인계했다.
 */
function sendSse(reply: FastifyReply, body: Extract<AnswerResponse, { found: true }>): FastifyReply {
  /*
   * **`reply.send(합친 문자열)`이 아니라 프레임마다 `write`한다.** 지금은 답변이 이미 완성돼
   * 있어 관측 가능한 차이가 없지만, 한 덩어리로 보내면 그것은 SSE 모양의 바디일 뿐 스트림이
   * 아니고, 토큰 스트리밍 provider가 붙을 때 이 함수를 통째로 다시 써야 한다.
   * `hijack()`은 Fastify에게 응답을 직접 끝내겠다고 알린다 — 안 하면 Fastify가 뒤이어
   * 자기 직렬화 결과를 덧붙이려다 죽는다.
   */
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": `${SSE_CONTENT_TYPE}; charset=utf-8`,
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  for (const text of splitAnswerChunks(body.answer)) {
    reply.raw.write(sseFrame(SSE_EVENTS.CHUNK, { text }));
  }
  // 종료 이벤트가 인용을 싣는다. 답변 본문은 chunk를 이어 붙인 것과 같으므로 중복하지 않는다.
  reply.raw.write(sseFrame(SSE_EVENTS.DONE, { found: true, citations: body.citations }));
  reply.raw.end();

  return reply;
}

function errorCodeOf(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** 검증 실패 로그용. 파싱 전 바디라 형상을 신뢰할 수 없으므로 방어적으로 읽는다(`search.ts` 규약). */
function readBoolean(body: unknown, key: string): boolean | null {
  const value = pick(body, key);
  return typeof value === "boolean" ? value : null;
}

function readLength(body: unknown, key: string): number | null {
  const value = pick(body, key);
  return typeof value === "string" ? value.length : null;
}

function pick(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}
