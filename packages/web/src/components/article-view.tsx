/**
 * 아티클 본문 뷰 — 상세 화면과 단일 HTML 내보내기가 **같은 트리**를 쓴다.
 *
 * 둘이 갈라지면 내보낸 파일이 화면과 다른 글이 되고, 그 순간 "공유용 내보내기"가
 * 신뢰를 잃는다. 특히 안전 규칙(본문을 텍스트 노드로만 렌더)이 한쪽에만 적용되는
 * 사고를 막는다 — 내보내기 경로는 React가 이스케이프한 마크업만 만든다.
 */
import type { ArticleSchema } from "@sentinel/contracts";

import {
  articleKindLabel,
  articleStatusLabel,
  formatArticleDate,
  sourceCountLabel,
} from "../lib/articles";
import { parseMarkdown } from "../lib/markdown";
import { ArticleBody } from "./article-body";
import { ArticleCharts } from "./article-chart";

export function ArticleView({ article }: { article: ArticleSchema }) {
  const blocks = article.body === undefined ? [] : parseMarkdown(article.body);

  return (
    <article>
      <h1 data-testid="article-title">{article.title}</h1>

      <p className="result-meta">
        <span className="badge">{articleKindLabel(article.kind)}</span>
        <span className="badge" data-testid="article-status">
          {articleStatusLabel(article.status)}
        </span>
        <span className="badge">{sourceCountLabel(article.sourceRecordIds.length)}</span>
        <span className="badge">
          생성{" "}
          <time dateTime={article.createdAt.toISOString()}>
            {formatArticleDate(article.createdAt)}
          </time>
        </span>
        {article.publishedAt === undefined ? null : (
          <span className="badge">
            발행{" "}
            <time dateTime={article.publishedAt.toISOString()}>
              {formatArticleDate(article.publishedAt)}
            </time>
          </span>
        )}
      </p>

      <ArticleCharts charts={article.charts} />

      {article.body === undefined ? (
        <p className="muted" data-testid="no-body">
          본문이 아직 없다. 후보는 소스 집합만 갖는다 — 본문은 초안 단계에서 생긴다(specs/08 §4).
        </p>
      ) : (
        <ArticleBody blocks={blocks} />
      )}

      {article.editHistory.length === 0 ? null : (
        <section aria-labelledby="edit-history-heading">
          <h2 id="edit-history-heading">편집 기록</h2>
          <ul className="result-list" data-testid="edit-history">
            {article.editHistory.map((edit, index) => (
              <li className="result-item" key={`${edit.at.toISOString()}-${String(index)}`}>
                <time dateTime={edit.at.toISOString()}>{formatArticleDate(edit.at)}</time>{" "}
                {edit.diffSummary}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
