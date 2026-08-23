/**
 * 초안 편집 + 발행 버튼. specs/08 §0-5·§7 "발행은 사람".
 *
 * 폼 두 개가 따로 있는 것이 요점이다. 저장과 발행을 한 버튼에 묶으면 "고치다 보니
 * 발행됐다"가 가능해지고, §7의 사람 승인이 형식만 남는다.
 *
 * 클라이언트 컴포넌트가 아니다 — `<form action={서버액션}>`이라 JS 없이도 동작한다.
 */
import { notFound } from "next/navigation";

import { ArticleCharts } from "../../../../components/article-chart";
import { ErrorBox } from "../../../../components/error-box";
import { CoreApiError, getArticle } from "../../../../lib/api-client";
import {
  articleHref,
  articleStatusLabel,
  canEditArticle,
  canPublishArticle,
  editErrorMessage,
  publishBlockReason,
} from "../../../../lib/articles";
import { publishArticleAction, saveArticleAction } from "../../actions";

export default async function ArticleEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const rawError = query["error"];
  const errorCode = typeof rawError === "string" ? rawError : undefined;
  const saved = query["saved"] !== undefined;

  try {
    const article = await getArticle(id);
    const editable = canEditArticle(article.status);
    const publishable = canPublishArticle(article);
    const blockReason = publishBlockReason(article);

    return (
      <>
        <h1>편집: {article.title}</h1>
        <p className="result-meta">
          <span className="badge" data-testid="article-status">
            {articleStatusLabel(article.status)}
          </span>
          <a href={articleHref(id)}>상세로</a>
        </p>

        {errorCode === undefined ? null : (
          <ErrorBox title="요청이 실패했다" code={errorCode} message={editErrorMessage(errorCode)} />
        )}

        {saved ? (
          <p className="notice notice-info" role="status" data-testid="saved-notice">
            <span className="notice-title">저장됨</span>
            편집 요약이 editHistory에 기록됐다(서버가 붙인다).
          </p>
        ) : null}

        {editable ? (
          /*
           * 편집 폼. `title`·`body`만 보낸다 — `PatchArticleInput`이 `.strict()`라
           * `publishedAt`·`status`·`editHistory`를 끼워 넣으면 전송 전에 터진다.
           */
          <form action={saveArticleAction} className="search-form" data-testid="edit-form">
            <input type="hidden" name="id" value={article._id} />
            <div className="field">
              <label htmlFor="article-title">제목</label>
              <input defaultValue={article.title} id="article-title" name="title" type="text" />
            </div>
            <div className="field">
              <label htmlFor="article-body">본문 (Markdown)</label>
              <textarea
                defaultValue={article.body ?? ""}
                id="article-body"
                name="body"
                rows={18}
                spellCheck={false}
              />
            </div>
            <button type="submit" data-testid="save-article">
              저장
            </button>
          </form>
        ) : (
          <p className="notice notice-warning" role="note" data-testid="not-editable">
            <span className="notice-title">편집할 수 없다</span>
            상태가 &quot;{articleStatusLabel(article.status)}&quot;인 아티클은 편집 대상이 아니다.
            편집은 candidate·draft에서만 허용된다(specs/04).
          </p>
        )}

        <h2>발행</h2>
        {publishable ? (
          /*
           * 발행 폼에는 **입력 필드가 `id` 하나뿐이다.** `publishedAt`을 담을 자리가 없고,
           * 액션도 그 값을 만들지 않는다 — 서버가 찍는다(specs/04).
           */
          <form action={publishArticleAction} data-testid="publish-form">
            <input type="hidden" name="id" value={article._id} />
            <button type="submit" data-testid="publish-article">
              발행한다 (사람 승인)
            </button>
          </form>
        ) : (
          <p className="notice notice-warning" role="note" data-testid="not-publishable">
            <span className="notice-title">발행할 수 없다</span>
            {blockReason}
          </p>
        )}

        <ArticleCharts charts={article.charts} />
      </>
    );
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    if (error.status === 404) notFound();
    return <ErrorBox title="아티클을 불러오지 못했다" code={error.code} message={error.message} />;
  }
}
