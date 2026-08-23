/**
 * 단일 HTML 내보내기 (T-033 Scope, specs/08 §5.3 "내보내기: 단일 HTML(공유용)").
 *
 * ## 안전이 어떻게 유지되는가
 * 마크업을 **문자열로 조립하지 않는다.** 상세 화면과 같은 React 트리(`ArticleView`)를
 * `renderToStaticMarkup`으로 렌더하므로, 본문의 모든 글자는 React가 이스케이프한다.
 * 여기서 문자열 템플릿에 본문을 끼워 넣었다면 화면에서 막은 인젝션이 내보낸 파일에서
 * 되살아났을 것이다 — `dangerouslySetInnerHTML`을 파일로 옮긴 것과 다르지 않다.
 * 아래 템플릿에 들어가는 값은 **제목과 스타일뿐**이고, 제목마저 `escapeHtml`을 거친다.
 *
 * 스타일은 인라인 `<style>`로 넣는다. "단일 HTML"의 뜻이 그것이다 — 외부 파일을 참조하면
 * 파일 하나를 건네받은 사람에게 깨진 문서가 간다.
 *
 * ## 왜 `react-dom/server.edge`의 `renderToReadableStream`인가 (실측으로 좁혀진 선택)
 * App Router는 `react-dom/server`를 import하면 빌드에서 거부하고("You're importing a
 * component that imports react-dom/server"), `server.edge`의 `renderToStaticMarkup`은
 * 런타임에 "do not use legacy react-dom/server APIs"로 거부한다. 둘 다 직접 확인했다.
 * 남는 것이 스트리밍 API 하나이며, 문서 하나를 만들어야 하므로 스트림을 모아 문자열로 쓴다.
 * 우회가 아니라 **프레임워크가 남겨 둔 유일한 정문**이다.
 */
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";

import { ArticleView } from "../../../../components/article-view";
import { CoreApiError, getArticle } from "../../../../lib/api-client";

/** 스트림을 문자열로 모은다. 문서 전체가 한 파일이어야 하므로 스트리밍하지 않는다. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  return out + decoder.decode();
}

/** 제목 하나를 템플릿에 넣기 위한 최소 이스케이프. 본문은 React가 처리한다. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 내보낸 파일이 혼자서도 읽히게 하는 최소 스타일. 화면 CSS의 부분집합이다. */
const EXPORT_STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 44rem; padding: 2rem 1rem;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans KR", sans-serif; line-height: 1.65; }
h1 { font-size: 1.6rem; line-height: 1.35; }
.result-meta { display: flex; flex-wrap: wrap; gap: .5rem; padding: 0; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: .05rem .55rem; font-size: .8rem; opacity: .8; }
.muted { opacity: .75; font-size: .9rem; }
.code-block { overflow-x: auto; padding: .75rem; border: 1px solid currentColor; border-radius: 6px; }
.chart-svg { width: 100%; height: auto; }
.chart-bar, .chart-cell { fill: currentColor; }
.chart-line { stroke: currentColor; stroke-width: 2; fill: none; }
.chart-dot { fill: currentColor; }
.chart-label, .chart-axis { fill: currentColor; font-size: 11px; opacity: .8; }
.timeline { padding-left: 1.2rem; }
blockquote { border-left: 3px solid currentColor; margin-left: 0; padding-left: 1rem; opacity: .9; }
`;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let markup: string;
  let title: string;
  try {
    const article = await getArticle(id);
    title = article.title;
    // JSX 대신 `createElement`를 쓰는 것은 이 파일이 `route.ts`(라우트 핸들러)이기 때문이다.
    markup = await readAll(await renderToReadableStream(createElement(ArticleView, { article })));
  } catch (error) {
    if (!(error instanceof CoreApiError)) throw error;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  const document = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_STYLE}</style>
</head>
<body>
${markup}
</body>
</html>
`;

  return new Response(document, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 브라우저에서 바로 읽히되 파일명이 붙도록 inline으로 둔다.
      "content-disposition": `inline; filename="article-${encodeURIComponent(id)}.html"`,
    },
  });
}
