/**
 * 아티클 본문(Markdown) → **블록 AST**. specs/08 §5.3 "Markdown 렌더".
 *
 * ## 왜 HTML 문자열을 만들지 않는가
 * 본문은 **모델이 쓴 Markdown**이고, T-031 F-1이 "한국어·영어 인젝션은 초안 프롬프트까지
 * 들어온다"고 명시했으므로 **신뢰할 수 없는 입력**이다. 그래서 이 모듈은 어느 단계에서도
 * 마크업 문자열을 만들지 않는다 — 텍스트를 **구조**로만 바꾸고, 그 구조를 컴포넌트가
 * React 엘리먼트로 렌더한다. React가 텍스트 노드를 이스케이프하므로 `<script>`도
 * `onerror=`도 **문자 그대로** 화면에 나온다. `dangerouslySetInnerHTML`이 필요 없고,
 * ref+DOM 삽입 같은 우회로도 필요 없다(T-023 규약, `client-safety.spec.ts`).
 *
 * ## 왜 마크다운 라이브러리를 쓰지 않는가
 * `react-markdown`·`marked` 계열은 대부분 HTML 통과(`allowDangerousHtml`·`rehype-raw`)를
 * 옵션으로 갖고 있고, 그 옵션 하나가 위 방어선 전체를 무효화한다. 여기서 필요한 것은
 * 아티클 본문이 실제로 쓰는 블록(제목·문단·목록·인용·코드펜스)뿐이라 **필요한 만큼만**
 * 구현하고, 문법이 아닌 것은 전부 평문으로 떨어뜨린다. 스펙에 없는 의존을 늘리지 않는다.
 */

// ---------------------------------------------------------------- 인라인

export type InlineNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  /** `href`가 `null`이면 스킴이 허용목록 밖이라 **링크로 만들지 않는다**(평문으로 렌더). */
  | { readonly kind: "link"; readonly text: string; readonly href: string | null };

/**
 * 링크로 만들어도 되는 URL인가.
 *
 * `javascript:`·`data:`·`vbscript:`는 클릭 한 번이 곧 실행이다. 본문이 신뢰할 수 없는
 * 입력이므로 **허용목록**으로 판정한다 — 차단목록은 새 스킴이 생길 때마다 뚫린다.
 * 공백·제어문자를 먼저 지우는 것은 `java\tscript:`류의 우회 때문이다(브라우저는
 * 스킴 안의 제어문자를 무시하고 실행한다).
 */
const ALLOWED_SCHEMES = ["http:", "https:", "mailto:"] as const;

export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // 스킴 판정 전에 제어문자·공백을 제거한다. 판정용 사본이며 결과에는 원문을 쓴다.
  // eslint-disable-next-line no-control-regex -- 제어문자 우회를 잡는 것이 목적이다.
  const probe = trimmed.replace(/[\u0000-\u0020]/g, "").toLowerCase();

  // 상대 경로와 문서 내 앵커는 스킴이 없다 — 실행 위험이 없으므로 허용한다.
  if (probe.startsWith("/") || probe.startsWith("#")) return trimmed;

  const colon = probe.indexOf(":");
  // 스킴이 없고 슬래시가 앞서지 않는 값(`docs/x.md`)도 상대 경로다.
  if (colon === -1) return trimmed;

  const scheme = probe.slice(0, colon + 1);
  return ALLOWED_SCHEMES.some((allowed) => allowed === scheme) ? trimmed : null;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]*\]\([^)\s]*\)|\*[^*]+\*)/g;

/** 한 줄(또는 문단)의 인라인 마크업을 노드 배열로. 문법이 아닌 것은 텍스트로 남는다. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;

  for (const match of source.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const start = match.index;
    if (start > cursor) {
      nodes.push({ kind: "text", text: source.slice(cursor, start) });
    }
    nodes.push(inlineToken(token));
    cursor = start + token.length;
  }

  if (cursor < source.length) {
    nodes.push({ kind: "text", text: source.slice(cursor) });
  }
  return nodes;
}

function inlineToken(token: string): InlineNode {
  if (token.startsWith("**")) return { kind: "strong", text: token.slice(2, -2) };
  if (token.startsWith("`")) return { kind: "code", text: token.slice(1, -1) };
  if (token.startsWith("[")) {
    const split = token.indexOf("](");
    const text = token.slice(1, split);
    const href = token.slice(split + 2, -1);
    return { kind: "link", text, href: safeHref(href) };
  }
  return { kind: "em", text: token.slice(1, -1) };
}

// ---------------------------------------------------------------- 블록

export type MarkdownBlock =
  | { readonly kind: "heading"; readonly level: 2 | 3 | 4; readonly inline: readonly InlineNode[] }
  | { readonly kind: "paragraph"; readonly inline: readonly InlineNode[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly InlineNode[])[];
    }
  | { readonly kind: "quote"; readonly inline: readonly InlineNode[] }
  | { readonly kind: "code"; readonly language: string | null; readonly code: string }
  /**
   * mermaid 코드 펜스. **렌더된 다이어그램이 아니라 원문이다** — F-2 판단.
   * `diagramType`은 표기용 라벨일 뿐이며 컴파일 판정이 아니다(그건 배치의 몫,
   * `packages/core/src/publisher/mermaid.ts`).
   */
  | { readonly kind: "mermaid"; readonly code: string; readonly diagramType: string | null };

/** 본문의 h1은 아티클 제목이 차지한다 — 본문 제목은 h2부터 시작해 계층을 깨지 않는다. */
function headingLevel(hashes: number): 2 | 3 | 4 {
  if (hashes <= 1) return 2;
  if (hashes === 2) return 3;
  return 4;
}

/**
 * mermaid 소스의 다이어그램 종류. 첫 의미 있는 줄의 첫 토큰이다.
 *
 * `%%{init: ...}%%` 디렉티브 줄은 건너뛴다 — 그 줄이 첫 토큰이 되면 라벨이
 * "%%"가 되기 때문이다. **디렉티브를 해석하지도 실행하지도 않는다**: 이 함수는
 * 라벨 하나를 뽑을 뿐이고, 소스 전체는 어차피 텍스트로만 렌더된다.
 */
export function mermaidDiagramType(code: string): string | null {
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("%%")) continue;
    const token = /^[A-Za-z][\w-]*/.exec(trimmed);
    return token?.[0] ?? null;
  }
  return null;
}

const FENCE = /^```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/**
 * Markdown 본문을 블록 배열로. 지원하지 않는 문법은 **문단 텍스트로 떨어진다** —
 * 파싱 실패로 화면을 비우지 않는다(읽기 UI의 기본 태도).
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence !== null) {
      const language = (fence[1] ?? "").trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test((lines[index] ?? "").trim())) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      // 닫는 펜스가 없어도 여기서 끝난다 — 남은 줄을 통째로 코드로 본다.
      index += 1;
      const code = body.join("\n");
      blocks.push(
        language.toLowerCase() === "mermaid"
          ? { kind: "mermaid", code, diagramType: mermaidDiagramType(code) }
          : { kind: "code", language: language === "" ? null : language, code },
      );
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: headingLevel((heading[1] ?? "#").length),
        inline: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(trimmed)) {
      const parts: string[] = [];
      while (index < lines.length) {
        const quote = QUOTE.exec((lines[index] ?? "").trim());
        if (quote === null) break;
        parts.push(quote[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", inline: parseInline(parts.join(" ").trim()) });
      continue;
    }

    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      const ordered = ORDERED.test(trimmed);
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? "").trim();
        const item = ordered ? ORDERED.exec(current) : BULLET.exec(current);
        if (item === null) break;
        items.push(parseInline(item[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? "").trim();
      if (
        current === "" ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}
