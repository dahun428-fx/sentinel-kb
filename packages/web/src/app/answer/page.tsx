/**
 * 인용 포함 답변 화면 (T-023 Scope "인용 클릭 시 해당 레코드로 이동", FR-04).
 *
 * 인용은 `recordSectionHref`로 상세 페이지의 해당 섹션 앵커까지 곧장 간다 —
 * 근거를 확인하는 데 검색을 한 번 더 시키지 않는 것이 인용의 존재 이유다.
 * 근거가 없으면 core-api가 `found:false`를 주며, 여기서도 답변을 지어내지 않는다(NFR-02).
 */
import type { AnswerResponse } from "@sentinel/contracts";

import { ErrorBox } from "../../components/error-box";
import { SearchForm } from "../../components/search-form";
import { answerQuestion, CoreApiError } from "../../lib/api-client";
import { formatFusionScore, recordSectionHref, sectionLabel } from "../../lib/display";
import {
  consoleHref,
  isSearchable,
  MIN_QUERY_LENGTH,
  parseConsoleQuery,
  type RawSearchParams,
} from "../../lib/search-params";

export default async function AnswerPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const query = parseConsoleQuery(await searchParams);

  let answer: AnswerResponse | null = null;
  let failure: CoreApiError | null = null;

  if (isSearchable(query)) {
    try {
      answer = await answerQuestion({
        query: query.q,
        ...(query.project === undefined ? {} : { project: query.project }),
      });
    } catch (error) {
      if (!(error instanceof CoreApiError)) throw error;
      failure = error;
    }
  }

  return (
    <>
      <h1>인용 포함 답변</h1>
      <p className="muted">
        검색된 기록만 근거로 답한다. 근거가 없으면 답을 만들지 않고 기록을 제안한다.
      </p>

      <SearchForm action="/answer" query={query} submitLabel="답변 생성" />

      <p>
        <a href={consoleHref("/", query)}>검색 결과 목록으로</a>
      </p>

      {!isSearchable(query) ? (
        <p className="muted">질의를 {MIN_QUERY_LENGTH}자 이상 입력하라.</p>
      ) : null}

      {failure !== null ? (
        <ErrorBox title="답변 생성에 실패했다" code={failure.code} message={failure.message} />
      ) : null}

      {answer !== null && answer.found ? (
        <section aria-labelledby="answer-heading">
          <h2 id="answer-heading">답변</h2>
          <p className="body-text" data-testid="answer-body">
            {answer.answer}
          </p>

          <h2 id="citations-heading">근거 인용</h2>
          <ul className="citation-list" aria-labelledby="citations-heading" data-testid="citations">
            {answer.citations.map((citation, index) => (
              <li key={`${citation.recordId}-${citation.section}-${String(index)}`}>
                <a
                  href={recordSectionHref(citation.recordId, citation.section)}
                  data-testid="citation-link"
                >
                  {citation.title} — {sectionLabel(citation.section)}
                </a>{" "}
                <span className="badge">{formatFusionScore(citation.score)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {answer !== null && !answer.found ? (
        <section aria-labelledby="not-found-heading" data-testid="answer-not-found">
          <h2 id="not-found-heading">유사 사례 없음</h2>
          <p className="body-text">{answer.message}</p>
          <p className="muted">
            이 문제를 해결하면 MCP `record_knowledge`로 기록해 다음 사람이 찾게 하라.
          </p>
        </section>
      ) : null}
    </>
  );
}
