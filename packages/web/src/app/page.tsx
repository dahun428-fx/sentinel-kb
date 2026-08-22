/**
 * 검색 콘솔 — 쿼리 + 필터 + 결과 목록 (T-023 Scope, FR-08).
 *
 * 서버 컴포넌트다. core-api 호출도, API 키도 이 함수 안에서만 산다(NFR-04).
 * DB는 건드리지 않는다 — 웹은 core-api HTTP만 소비한다(specs/01).
 */
import type { SearchResponse } from "@sentinel/contracts";

import { ErrorBox } from "../components/error-box";
import { ResultList } from "../components/result-list";
import { SearchForm } from "../components/search-form";
import { CoreApiError, searchRecords } from "../lib/api-client";
import {
  consoleHref,
  isSearchable,
  MIN_QUERY_LENGTH,
  parseConsoleQuery,
  type RawSearchParams,
} from "../lib/search-params";

export default async function SearchConsolePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const query = parseConsoleQuery(await searchParams);

  let results: SearchResponse | null = null;
  let failure: CoreApiError | null = null;

  if (isSearchable(query)) {
    try {
      results = await searchRecords({
        query: query.q,
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.project === undefined ? {} : { project: query.project }),
      });
    } catch (error) {
      if (!(error instanceof CoreApiError)) throw error;
      failure = error;
    }
  }

  return (
    <>
      <h1>지식 검색</h1>
      <p className="muted">
        과거 장애·이격 기록을 하이브리드 검색(vector + text)으로 찾는다. 읽기 전용 화면이다.
      </p>

      <SearchForm action="/" query={query} submitLabel="검색" />

      {isSearchable(query) ? (
        <p>
          <a href={consoleHref("/answer", query)} data-testid="to-answer">
            이 질의로 인용 포함 답변 보기
          </a>
        </p>
      ) : (
        <p className="muted" data-testid="query-hint">
          질의를 {MIN_QUERY_LENGTH}자 이상 입력하면 검색한다.
        </p>
      )}

      <h2>검색 결과</h2>

      {failure !== null ? (
        <ErrorBox title="검색에 실패했다" code={failure.code} message={failure.message} />
      ) : null}

      {results !== null ? <ResultList results={results.results} /> : null}
    </>
  );
}
