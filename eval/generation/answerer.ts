/**
 * `POST /v1/answer` 호출부 + 인용된 레코드 조회. 출처: T-020 Scope, specs/04.
 *
 * **HTTP로 부른다. `generateAnswer()`를 직접 부르지 않는다.** T-013(`search-client.ts`)이
 * 세운 규약과 같은 근거다 — eval이 재는 것은 라이브러리가 아니라 사용자·에이전트가 실제로
 * 통과하는 경로이고, 게이트 순서·SSE 분기·응답 투영이 전부 지표에 포함되어야 한다.
 *
 * ## 인용 룰체크의 "허용 집합"은 어디서 오는가
 * `AnswerResponse.citations`는 **컨텍스트에 실제로 들어간 청크**에서 나온다(`toCitations`).
 * 그 `{recordId, section}`을 `citationFor`로 되돌리면 모델이 쓸 수 있었던 인용 문자열의
 * 집합이 그대로 나온다. **`citationFor`를 여기서 다시 구현하지 않는다** — 형식이 갈라지면
 * eval이 "형식이 달라서" 실패하고, 그건 생성 품질이 아니다(CLAUDE.md: 계약은 한 곳).
 *
 * ## judge에게 줄 근거는 레코드에서 가져온다
 * 답변 응답에는 청크 본문이 없다(NFR-03, 의도된 것이다). faithfulness는 근거 없이는 잴 수
 * 없으므로 인용된 레코드를 `GET /v1/records/:id`로 따로 읽는다. **eval 계층이라 가능한
 * 일이고, 이 텍스트는 리포트에 저장되지 않는다** — judge 요청에만 쓰이고 버려진다.
 */
import { AnswerResponse, RecordSchema, type Citation } from "@sentinel/contracts";
import { citationFor } from "@sentinel/core";

export interface AnswerResult {
  readonly found: boolean;
  readonly answer: string;
  readonly citations: Citation[];
  /** 모델이 쓸 수 있었던 인용 문자열 전부. 룰체크의 "실제 컨텍스트" 집합이다. */
  readonly allowedCitations: string[];
}

export type AnswerFn = (query: string) => Promise<AnswerResult>;

/** 인용된 레코드의 본문(judge 전용). 리포트에는 저장되지 않는다. */
export interface SourceText {
  readonly citation: string;
  readonly title: string;
  readonly text: string;
}

export type FetchSourcesFn = (citations: readonly Citation[]) => Promise<SourceText[]>;

export class EvalAnswerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EvalAnswerError";
    this.status = status;
  }
}

export interface AnswerClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 테스트가 네트워크 없이 클라이언트를 돌리기 위한 주입 지점. */
  readonly fetchImpl?: typeof fetch;
}

/** 응답 본문에서 사람에게 보여 줄 만큼만 자른다. 통째로 던지면 로그가 레코드 본문으로 찬다. */
const ERROR_BODY_MAX_CHARS = 300;

export function createAnswerClient(options: AnswerClientOptions): AnswerFn {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = new URL("/v1/answer", options.baseUrl).toString();

  return async function answer(query: string): Promise<AnswerResult> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        // 키는 헤더로만 나간다. 에러 메시지·로그 어디에도 싣지 않는다(CLAUDE.md 시크릿 규칙).
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      // `stream:false`가 기본이다. SSE로 받으면 프레임을 다시 이어 붙여야 하고,
      // 그 재조립이 틀리면 인용 룰체크가 **전송 버그를 생성 품질로** 신고한다.
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
      throw new EvalAnswerError(
        response.status,
        `POST /v1/answer가 ${String(response.status)}로 응답했다: ${body}`,
      );
    }

    return toAnswerResult(AnswerResponse.parse(await response.json()));
  };
}

/** 계약 응답 → 러너가 쓰는 형상. 순수 함수라 단위 테스트가 직접 때린다. */
export function toAnswerResult(parsed: AnswerResponse): AnswerResult {
  if (!parsed.found) return { found: false, answer: "", citations: [], allowedCitations: [] };
  return {
    found: true,
    answer: parsed.answer,
    citations: parsed.citations,
    allowedCitations: [
      ...new Set(parsed.citations.map((c) => citationFor(c.recordId, c.section))),
    ],
  };
}

export function createSourceFetcher(options: AnswerClientOptions): FetchSourcesFn {
  const doFetch = options.fetchImpl ?? fetch;

  return async function fetchSources(citations: readonly Citation[]): Promise<SourceText[]> {
    const sources: SourceText[] = [];
    for (const citation of citations) {
      const url = new URL(`/v1/records/${citation.recordId}`, options.baseUrl).toString();
      const response = await doFetch(url, {
        headers: { authorization: `Bearer ${options.apiKey}` },
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
        throw new EvalAnswerError(
          response.status,
          `GET /v1/records/${citation.recordId}가 ${String(response.status)}로 응답했다: ${body}`,
        );
      }
      const record = RecordSchema.parse(await response.json());
      const section = (record as unknown as Record<string, unknown>)[citation.section];
      sources.push({
        citation: citationFor(citation.recordId, citation.section),
        title: record.title,
        text: typeof section === "string" ? section : "",
      });
    }
    return sources;
  };
}
