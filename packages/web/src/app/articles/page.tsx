/**
 * 아티클 **공개 목록**. specs/08 §5.3 "web에 `/articles` 라우트".
 *
 * ## T-033 Acceptance 3: candidate는 여기 나오지 않는다
 * 이 파일에는 **필터가 없다.** `listPublishedArticles()`는 `status` 인자를 받지 않고,
 * 서버가 `ListArticlesQuery.status`의 기본값(`published`)으로 조건 없이 거른다.
 * specs/04 표 아래 블록쿼트 2번이 그 배치의 이유를 적는다:
 * > 필터를 빠뜨렸을 때의 결과가 안전한 쪽이어야 한다.
 * 클라이언트에서 거르면 "전량을 받아서 숨기는" 배치가 되는데, T-033이 BLOCKED로 남긴
 * 기록이 지목한 것이 바로 그 배치다.
 *
 * 서버 컴포넌트다 — API 키는 이 함수 안에서만 산다(NFR-04).
 */
import type { ArticleSummary } from "@sentinel/contracts";

import { ErrorBox } from "../../components/error-box";
import {
  articleHref,
  articleKindLabel,
  articleStatusLabel,
  formatArticleDate,
  parseCursor,
  publicArticlesHref,
  sourceCountLabel,
} from "../../lib/articles";
import { CoreApiError, listPublishedArticles } from "../../lib/api-client";

export default async function ArticleListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const cursor = parseCursor(params["cursor"]);

  let items: readonly ArticleSummary[] = [];
  let nextCursor: string | null = null;
  let failure: CoreApiError | null = null;

  try {
    const page = await listPublishedArticles(cursor);
    items = page.items;
    nextCursor = page.nextCursor;
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    failure = error;
  }

  return (
    <>
      <h1>발행 아티클</h1>
      <p className="muted">
        기록에서 자동 편찬되고 <strong>사람이 발행한</strong> 글이다(specs/08 §7: 전자동 발행 금지).
        후보와 초안은 이 목록에 없다 — 보려면{" "}
        {/* 상태 이름조차 이 파일에 적지 않는다 — 큐 화면이 자기 기본값(candidate)을 정한다. */}
        <a href="/articles/queue" data-testid="to-queue">
          후보 큐
        </a>
        로 간다.
      </p>

      {failure !== null ? (
        <ErrorBox title="목록을 불러오지 못했다" code={failure.code} message={failure.message} />
      ) : null}

      {failure === null && items.length === 0 ? (
        <p className="muted" data-testid="empty-articles">
          발행된 아티클이 아직 없다.
        </p>
      ) : null}

      <ul className="result-list" data-testid="article-list">
        {items.map((item) => (
          <li className="result-item" key={item._id}>
            <p className="result-meta">
              <span className="badge">{articleKindLabel(item.kind)}</span>
              <span className="badge" data-testid="article-status">
                {articleStatusLabel(item.status)}
              </span>
              <span className="badge">{sourceCountLabel(item.sourceRecordCount)}</span>
              {item.publishedAt === undefined ? null : (
                <span className="badge">
                  발행{" "}
                  <time dateTime={item.publishedAt.toISOString()}>
                    {formatArticleDate(item.publishedAt)}
                  </time>
                </span>
              )}
            </p>
            <h2>
              <a href={articleHref(item._id)}>{item.title}</a>
            </h2>
            <p className="muted">/{item.slug}</p>
          </li>
        ))}
      </ul>

      {nextCursor === null ? null : (
        <p>
          <a href={publicArticlesHref(nextCursor)} data-testid="next-page">
            다음 페이지
          </a>
        </p>
      )}
    </>
  );
}
