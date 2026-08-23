/**
 * 아티클 상세. specs/08 §5.3 "Markdown 렌더 + mermaid + 차트 컴포넌트".
 *
 * `GET /v1/articles/:id`는 본문을 포함한다(specs/04). 상태에 관계없이 **직접 링크로는
 * 열린다** — 후보 큐가 후보를 열어 봐야 편집할 수 있기 때문이다. Acceptance 3이 말하는
 * 것은 **목록 노출**이며, 그 경계는 `/articles`(공개 목록)가 지킨다.
 */
import { notFound } from "next/navigation";

import { ArticleView } from "../../../components/article-view";
import { ErrorBox } from "../../../components/error-box";
import { CoreApiError, getArticle } from "../../../lib/api-client";
import { articleEditHref, articleExportHref, canEditArticle } from "../../../lib/articles";

export default async function ArticleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const article = await getArticle(id);

    return (
      <>
        <ArticleView article={article} />

        <p className="result-meta" style={{ marginTop: "2rem" }}>
          <a href="/articles">발행 목록</a>
          <a href={articleExportHref(id)} data-testid="to-export">
            단일 HTML로 내보내기
          </a>
          {canEditArticle(article.status) ? (
            <a href={articleEditHref(id)} data-testid="to-edit">
              편집·발행
            </a>
          ) : null}
        </p>
      </>
    );
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    if (error.status === 404) notFound();
    return <ErrorBox title="아티클을 불러오지 못했다" code={error.code} message={error.message} />;
  }
}
