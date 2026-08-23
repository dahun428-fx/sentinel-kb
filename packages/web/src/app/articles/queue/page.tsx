/**
 * 후보 큐. specs/04: "`status=candidate|draft`를 **명시해야** 후보 큐가 보인다."
 *
 * **경로가 다른 것이 요점이다.** 공개 목록(`/articles`)과 같은 화면에 탭으로 얹으면
 * "필터를 하나 지우면 후보가 공개 목록에 뜨는" 구조가 되고, 그건 Acceptance 3이 금지한
 * 배치다. 여기서만 `listArticleQueue`를 부르고, 그 함수는 `status`를 **필수 인자**로 받는다.
 */
import type { ArticleSummary } from "@sentinel/contracts";

import { ErrorBox } from "../../../components/error-box";
import {
  articleEditHref,
  articleHref,
  articleKindLabel,
  articleQueueHref,
  articleStatusLabel,
  formatArticleDate,
  parseCursor,
  parseQueueStatus,
  QUEUE_STATUSES,
  sourceCountLabel,
} from "../../../lib/articles";
import { CoreApiError, listArticleQueue } from "../../../lib/api-client";

export default async function ArticleQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = parseQueueStatus(params["status"]);
  const cursor = parseCursor(params["cursor"]);

  let items: readonly ArticleSummary[] = [];
  let nextCursor: string | null = null;
  let failure: CoreApiError | null = null;

  try {
    const page = await listArticleQueue(status, cursor);
    items = page.items;
    nextCursor = page.nextCursor;
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    failure = error;
  }

  return (
    <>
      <h1>후보 큐</h1>
      <p className="muted">
        아직 발행되지 않은 아티클이다. 발행은 사람이 누른다 — 야간 배치는 후보를 쌓기만 한다
        (specs/08 §1·§7). 공개 목록에는 나오지 않는다.
      </p>

      <nav aria-label="상태" className="result-meta">
        {QUEUE_STATUSES.map((candidate) => (
          <a
            className="badge"
            key={candidate}
            href={articleQueueHref(candidate)}
            aria-current={candidate === status ? "page" : undefined}
            data-testid={`queue-tab-${candidate}`}
          >
            {articleStatusLabel(candidate)}
          </a>
        ))}
        <a className="badge" href="/articles">
          발행 목록
        </a>
      </nav>

      {failure !== null ? (
        <ErrorBox title="후보 큐를 불러오지 못했다" code={failure.code} message={failure.message} />
      ) : null}

      {failure === null && items.length === 0 ? (
        <p className="muted" data-testid="empty-queue">
          {articleStatusLabel(status)} 상태의 아티클이 없다.
        </p>
      ) : null}

      <ul className="result-list" data-testid="queue-list">
        {items.map((item) => (
          <li className="result-item" key={item._id}>
            <p className="result-meta">
              <span className="badge">{articleKindLabel(item.kind)}</span>
              <span className="badge" data-testid="queue-status">
                {articleStatusLabel(item.status)}
              </span>
              <span className="badge">{sourceCountLabel(item.sourceRecordCount)}</span>
              <span className="badge">
                생성{" "}
                <time dateTime={item.createdAt.toISOString()}>
                  {formatArticleDate(item.createdAt)}
                </time>
              </span>
            </p>
            <h2>
              <a href={articleHref(item._id)}>{item.title}</a>
            </h2>
            <p>
              <a href={articleEditHref(item._id)} data-testid="to-edit">
                편집·발행
              </a>
            </p>
          </li>
        ))}
      </ul>

      {nextCursor === null ? null : (
        <p>
          <a href={`${articleQueueHref(status)}&cursor=${encodeURIComponent(nextCursor)}`}>
            다음 페이지
          </a>
        </p>
      )}
    </>
  );
}
