/**
 * `POST /v1/search` 호출부. 출처: T-013 Scope("골든셋 로더 → /v1/search 호출").
 *
 * **HTTP로 부른다. `retrieve()`를 직접 부르지 않는다.** eval이 재는 것은 라이브러리가 아니라
 * 사용자·에이전트가 실제로 통과하는 경로다 — 라우트의 `limit` 해석, dedupe, 응답 투영이 전부
 * 지표에 포함되어야 한다(T-012는 `SearchRequest.limit`이 `RETRIEVAL_FINAL_K`를 이긴다고 결정했고,
 * 그 결정은 라우트 안에만 있다).
 *
 * 응답은 contracts의 `SearchResponse`로 파싱한다 — 형상을 여기서 다시 적지 않는다(CLAUDE.md).
 */
import { SearchResponse, type RecordType } from "@sentinel/contracts";

import type { RankedHit } from "./metrics.js";

export interface SearchInput {
  readonly query: string;
  readonly limit: number;
  readonly type?: RecordType;
}

export type SearchFn = (input: SearchInput) => Promise<RankedHit[]>;

export class EvalSearchError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EvalSearchError";
    this.status = status;
  }
}

export interface SearchClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 테스트가 네트워크 없이 클라이언트를 돌리기 위한 주입 지점. */
  readonly fetchImpl?: typeof fetch;
}

/** 응답 본문에서 사람에게 보여 줄 만큼만 자른다. 통째로 던지면 로그가 레코드 본문으로 찬다. */
const ERROR_BODY_MAX_CHARS = 300;

export function createSearchClient(options: SearchClientOptions): SearchFn {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = new URL("/v1/search", options.baseUrl).toString();

  return async function search(input: SearchInput): Promise<RankedHit[]> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        // 키는 헤더로만 나간다. 에러 메시지·로그 어디에도 싣지 않는다(CLAUDE.md 시크릿 규칙).
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        limit: input.limit,
        // `project`는 보내지 않는다 — 키의 클레임이 곧 스코프이고, 바디로 좁히면
        // eval이 재는 범위가 운영 호출과 달라진다.
        ...(input.type === undefined ? {} : { type: input.type }),
      }),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
      throw new EvalSearchError(
        response.status,
        `POST /v1/search가 ${String(response.status)}로 응답했다: ${body}`,
      );
    }

    const parsed = SearchResponse.parse(await response.json());
    return parsed.results.map((hit) => ({ recordId: hit.recordId, score: hit.score }));
  };
}
