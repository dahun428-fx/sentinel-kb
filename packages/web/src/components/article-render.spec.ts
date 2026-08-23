/**
 * 컴포넌트 렌더 회귀를 **`pnpm verify` 안에서** 잡는다.
 *
 * ## 왜 이 파일이 생겼는가 (뮤테이션 실측)
 * T-023 F-5가 "컴포넌트 렌더 회귀를 verify가 못 막는다"고 적었고, T-033의 뮤테이션에서
 * 그 말이 그대로 관측됐다. 두 뮤턴트가 lint·typecheck·unit을 **전부 통과했다**:
 *   - `ArticleCharts`가 `charts.filter((spec) => spec.type !== "heatmap")`로 히트맵을 조용히 버림
 *   - 편집 페이지의 `editable`을 `true`로 고정 (published에도 편집 폼이 열림)
 * 둘 다 E2E에서만 죽었는데, E2E는 머지 게이트가 아니다(T-023 규약). 즉 **막는 것이 없었다.**
 *
 * 첫 번째는 여기서 닫는다 — 실제로 렌더한 마크업을 본다. 두 번째는 페이지가 async 서버
 * 컴포넌트라 여기서 렌더할 수 없어 `articles-safety.spec.ts`의 소스 가드로 닫았다.
 *
 * `react-dom/server`를 여기서 쓰는 것은 안전하다. 이건 Node에서 도는 단위 테스트이고,
 * 앱 코드가 아니다 — App Router가 그 모듈을 거부하는 것은 라우트·컴포넌트 트리 안에서다.
 * JSX 대신 `createElement`를 쓰는 것은 unit 프로젝트가 `*.spec.ts`만 수집하기 때문이다.
 */
import type { ChartSpec } from "@sentinel/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../lib/markdown";
import { ArticleBody } from "./article-body";
import { ArticleCharts } from "./article-chart";

const CHARTS: ChartSpec[] = [
  {
    type: "bar",
    data: { points: [{ label: "payment", value: 4 }] },
    caption: "태그 빈도",
  },
  {
    type: "line",
    data: { points: [{ label: "2026-08-01", value: 1 }, { label: "2026-08-02", value: 3 }] },
    caption: "발생 시계열",
  },
  {
    type: "heatmap",
    data: {
      rows: ["opus"],
      columns: ["api"],
      cells: [{ row: "opus", column: "api", count: 2 }],
    },
    caption: "모델 × correction",
  },
  {
    type: "timeline",
    data: { events: [{ at: "2026-08-01T00:00:00.000Z", recordId: "r1", label: "SEV2 created" }] },
    caption: "사건 타임라인",
  },
];

function renderCharts(charts: ChartSpec[]): string {
  return renderToStaticMarkup(createElement(ArticleCharts, { charts }));
}

function renderBody(markdown: string): string {
  return renderToStaticMarkup(createElement(ArticleBody, { blocks: parseMarkdown(markdown) }));
}

describe("ArticleCharts 렌더 (Acceptance 2)", () => {
  const markup = renderCharts(CHARTS);

  it("bar가 실제로 svg로 그려진다", () => {
    expect(markup).toContain('data-chart-kind="bar"');
    expect(markup).toContain("<rect");
  });

  it("line이 실제로 polyline으로 그려진다", () => {
    expect(markup).toContain('data-chart-kind="line"');
    expect(markup).toContain("<polyline");
  });

  it("heatmap이 실제로 셀로 그려진다", () => {
    expect(markup).toContain('data-chart-kind="heatmap"');
  });

  it("timeline도 화면에 남는다 — 케이스 아티클의 유일한 차트다", () => {
    expect(markup).toContain('data-chart-kind="timeline"');
  });

  it("넘긴 차트 개수만큼 렌더된다 — 조용히 버려지는 종류가 없다", () => {
    expect(markup.split("data-testid=").length - 1).toBe(4);
  });

  it("캡션이 그림과 함께 나온다 — 숫자만 있는 그림은 근거가 아니다", () => {
    expect(markup).toContain("태그 빈도");
    expect(markup).toContain("모델 × correction");
  });

  it("차트가 없으면 아무것도 그리지 않는다", () => {
    expect(renderCharts([])).toBe("");
  });
});

describe("ArticleBody 렌더 — 본문은 신뢰 불가 입력이다 (T-031 F-1)", () => {
  it("본문의 script 태그는 이스케이프되어 실행 가능한 마크업이 아니다", () => {
    const markup = renderBody("<script>window.x = 1</script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("이미지 onerror 같은 속성도 글자로만 남는다", () => {
    const markup = renderBody("<img src=x onerror=alert(1)>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("onerror=alert(1)");
  });

  it("허용된 링크만 앵커가 된다", () => {
    expect(renderBody("[문서](https://example.com/a)")).toContain('href="https://example.com/a"');
  });

  it("javascript: 링크는 앵커가 되지 않는다", () => {
    const markup = renderBody("[클릭](javascript:alert)");
    expect(markup.toLowerCase()).not.toContain('href="javascript:');
    // 감추지는 않는다 — 무엇이 들어 있었는지 읽는 사람이 알아야 한다(specs/03 §2와 같은 태도).
    expect(markup).toContain("클릭");
  });
});

describe("F-2: mermaid는 코드로만 나온다", () => {
  const markup = renderBody("```mermaid\nflowchart TD\n  A-->B\n```");

  it("원문이 코드 블록으로 보인다", () => {
    expect(markup).toContain('data-testid="mermaid-source"');
    expect(markup).toContain("flowchart TD");
  });

  it("다이어그램 svg가 만들어지지 않는다", () => {
    expect(markup).not.toContain("<svg");
    // 태그를 본다 — 화면의 설명 문구가 이 단어를 쓰기 때문이다(설명이 위반으로 잡히면 안 된다).
    expect(markup).not.toContain("<foreignObject");
  });

  it("다이어그램 종류를 라벨로 알린다 — 무엇이 실려 있었는지는 숨기지 않는다", () => {
    expect(markup).toContain("flowchart");
  });
});
