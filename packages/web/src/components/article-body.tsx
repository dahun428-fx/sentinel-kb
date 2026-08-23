/**
 * 아티클 본문 렌더. `lib/markdown.ts`가 만든 **구조**를 React 엘리먼트로 옮긴다.
 *
 * 이 파일에는 `dangerouslySetInnerHTML`도, `ref`를 통한 DOM 삽입도, HTML 문자열도 없다.
 * 본문의 모든 글자는 React 텍스트 노드로 들어가므로 `<script>`든 `onerror=`든
 * **문자 그대로** 보인다. 본문은 모델이 쓴 신뢰 불가 입력이다(T-031 F-1).
 */
import type { InlineNode, MarkdownBlock } from "../lib/markdown";

function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${String(index)}`;
        switch (node.kind) {
          case "strong":
            return <strong key={key}>{node.text}</strong>;
          case "em":
            return <em key={key}>{node.text}</em>;
          case "code":
            return <code key={key}>{node.text}</code>;
          case "link":
            /**
             * `href`가 `null`이면 스킴이 허용목록 밖이다 — 링크로 만들지 않고
             * **텍스트로 떨어뜨린다.** 감추지 않는 이유는 `injection-suspect`를 감추지
             * 않는 것과 같다(specs/03 §2): 읽는 사람이 무엇이 들어 있었는지 알아야 한다.
             */
            return node.href === null ? (
              <span key={key} className="muted-inline" title="허용되지 않은 링크 스킴이라 링크로 만들지 않았다">
                {node.text}
              </span>
            ) : (
              <a key={key} href={node.href} rel="noreferrer nofollow">
                {node.text}
              </a>
            );
          case "text":
            return <span key={key}>{node.text}</span>;
        }
      })}
    </>
  );
}

/**
 * mermaid 블록. **다이어그램으로 렌더하지 않는다** — T-033 F-2.
 *
 * `mermaid.render()`는 SVG **문자열**을 돌려주고, 그 SVG는 `foreignObject`로 임의 HTML을
 * 품을 수 있다. 문자열을 DOM에 넣는 길은 `dangerouslySetInnerHTML`과 `ref + innerHTML`
 * 둘뿐이며, 후자는 `client-safety.spec.ts`의 grep만 피할 뿐 위험은 그대로다.
 * 그래서 원문을 **코드 블록으로** 보여준다. 종류 라벨은 무엇이 실려 있었는지 알리기 위한 것이다.
 */
function MermaidBlock({ code, diagramType }: { code: string; diagramType: string | null }) {
  return (
    <figure className="diagram-block" data-testid="mermaid-block">
      <figcaption className="muted">
        mermaid 다이어그램{diagramType === null ? "" : ` (${diagramType})`} — 원문 코드로 표시한다.
        렌더하지 않는 이유는 T-033 F-2(신뢰 불가 본문 + SVG foreignObject).
      </figcaption>
      <pre className="code-block">
        <code data-testid="mermaid-source">{code}</code>
      </pre>
    </figure>
  );
}

export function ArticleBody({ blocks }: { blocks: readonly MarkdownBlock[] }) {
  return (
    <div className="article-body" data-testid="article-body">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${String(index)}`;
        switch (block.kind) {
          case "heading": {
            const Tag = (["h2", "h3", "h4"] as const)[block.level - 2] ?? "h4";
            return (
              <Tag key={key}>
                <Inline nodes={block.inline} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={key}>
                <Inline nodes={block.inline} />
              </p>
            );
          case "quote":
            return (
              <blockquote key={key}>
                <Inline nodes={block.inline} />
              </blockquote>
            );
          case "list":
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${String(itemIndex)}`}>
                    <Inline nodes={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${String(itemIndex)}`}>
                    <Inline nodes={item} />
                  </li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre className="code-block" key={key}>
                <code>{block.code}</code>
              </pre>
            );
          case "mermaid":
            return <MermaidBlock code={block.code} diagramType={block.diagramType} key={key} />;
        }
      })}
    </div>
  );
}
