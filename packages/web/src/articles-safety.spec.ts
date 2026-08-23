/**
 * T-033의 소스 단위 가드. `client-safety.spec.ts`와 같은 방식(소스를 훑어 **경로 자체**를 막는다)이며,
 * 기존 파일을 고치지 않고 새로 둔다 — 통과시키려고 남의 테스트에 손대는 일이 없어야 한다.
 *
 * ## 왜 소스 스캔인가
 * T-023 F-5가 "컴포넌트 렌더 회귀를 `pnpm verify`가 못 막는다"고 지적했다. 잠글 수 있는 것은
 * `lib/*.spec.ts`가 순수 함수로 잠갔고, **잠글 수 없는 것(어느 페이지가 무엇을 부르는가)**을
 * 여기서 잠근다. E2E는 `pnpm verify` 밖이라 머지 게이트가 되지 못한다(T-023 규약).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripSourceComments } from "./lib/source-scan";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function collect(): SourceFile[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .filter((entry) => !entry.endsWith(".spec.ts") && !entry.endsWith(".spec.tsx"))
    .map((entry) => ({
      path: entry.split("\\").join("/"),
      text: stripSourceComments(readFileSync(join(SRC_DIR, entry), "utf8")),
    }));
}

const SOURCES = collect();

function source(path: string): string {
  const found = SOURCES.find((file) => file.path === path);
  if (found === undefined) {
    throw new Error(`${path}가 없다 — 이 가드가 아무것도 지키지 않게 됐다는 뜻이다`);
  }
  return found.text;
}

/** 아티클 화면 파일. 스캔이 빈 통과가 되지 않도록 존재부터 확인한다. */
const ARTICLE_SOURCES = [
  "app/articles/page.tsx",
  "app/articles/queue/page.tsx",
  "app/articles/[id]/page.tsx",
  "app/articles/[id]/edit/page.tsx",
  "app/articles/actions.ts",
  "components/article-body.tsx",
  "components/article-chart.tsx",
  "components/article-view.tsx",
] as const;

describe("아티클 화면 스캔 대상", () => {
  it("스캔할 파일이 실제로 존재한다 — 빈 통과를 방지한다", () => {
    for (const path of ARTICLE_SOURCES) {
      expect(() => source(path)).not.toThrow();
    }
  });
});

describe("Acceptance 3: candidate가 공개 목록에 유입되지 않는다", () => {
  it("공개 목록 페이지는 후보 큐 호출을 알지 못한다", () => {
    expect(source("app/articles/page.tsx")).not.toContain("listArticleQueue");
  });

  it("공개 목록 페이지는 상태를 고르는 말을 꺼내지 않는다 — 필터는 서버의 것이다", () => {
    const page = source("app/articles/page.tsx");
    expect(page).not.toContain("status=");
    expect(page).not.toContain('"candidate"');
    expect(page).not.toContain('"draft"');
    expect(page).not.toContain("parseQueueStatus");
  });

  it("후보 큐만 큐 호출을 쓴다", () => {
    const callers = SOURCES.filter((file) => file.text.includes("listArticleQueue("));
    expect(callers.map((file) => file.path).sort()).toEqual([
      "app/articles/queue/page.tsx",
      "lib/api-client.ts",
    ]);
  });
});

describe("Acceptance: publishedAt은 서버가 찍는다", () => {
  it("쓰기 경로 파일들은 publishedAt이라는 말을 아예 쓰지 않는다", () => {
    /*
     * 읽기(표시)는 허용이다 — `article-view.tsx`는 발행 시각을 **보여준다**.
     * 금지되는 것은 **보내는 것**이므로, core-api로 나가는 바디를 만드는 세 파일만 본다.
     * 여기에 `publishedAt`이 생기면 그것은 곧 전송이다.
     */
    const writePath = ["lib/api-client.ts", "app/articles/actions.ts", "app/articles/[id]/edit/page.tsx"];
    const offenders = writePath.filter((path) => source(path).includes("publishedAt"));
    expect(offenders).toEqual([]);
  });

  it("발행 액션이 보내는 바디는 계약이 만든다", () => {
    expect(source("lib/api-client.ts")).toContain("publishRequestBody()");
  });
});

describe("F-2: mermaid를 마크업으로 만들지 않는다", () => {
  it("아티클 화면에도 dangerouslySetInnerHTML이 없다", () => {
    const offenders = SOURCES.filter((file) => file.text.includes("dangerouslySetInnerHTML"));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("ref+DOM 삽입 우회도 없다 — 문자열만 피하고 위험을 남기는 길이다", () => {
    const patterns = ["innerHTML", "insertAdjacentHTML", "createContextualFragment", "DOMParser"];
    const offenders = SOURCES.filter((file) =>
      patterns.some((pattern) => file.text.includes(pattern)),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("mermaid 렌더러를 import하지 않는다 — 렌더 대신 코드 블록으로 보여준다", () => {
    const offenders = SOURCES.filter((file) => /from\s+["']mermaid["']/.test(file.text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});

describe("편집 게이트가 화면에도 걸려 있다", () => {
  /*
   * **호출 형태까지 본다.** import만 남기고 `const editable = true;`로 바꾸는 뮤턴트가
   * lint·typecheck·unit을 전부 통과하는 것을 실측했다(T-033 뮤테이션 M5b). 이름이
   * 파일에 있다는 사실은 게이트가 걸려 있다는 뜻이 아니다 — 실제 인자로 상태를 넘겨야 한다.
   */
  it("편집 폼이 아티클의 실제 상태로 게이트된다", () => {
    expect(source("app/articles/[id]/edit/page.tsx")).toContain("canEditArticle(article.status)");
  });

  it("발행 버튼이 아티클 자신으로 게이트된다", () => {
    expect(source("app/articles/[id]/edit/page.tsx")).toContain("canPublishArticle(article)");
  });

  it("저장과 발행이 서로 다른 액션이다 — 고치다 보니 발행되는 일이 없어야 한다", () => {
    const actions = source("app/articles/actions.ts");
    expect(actions).toContain("saveArticleAction");
    expect(actions).toContain("publishArticleAction");
    expect(source("app/articles/[id]/edit/page.tsx")).toContain("publishArticleAction");
  });
});

describe("차트 3종이 실제로 화면 코드에 있다", () => {
  it("bar·line·heatmap 갈래가 모두 렌더된다", () => {
    const chart = source("components/article-chart.tsx");
    expect(chart).toContain('model.kind === "bar"');
    expect(chart).toContain('model.kind === "line"');
    expect(chart).toContain('model.kind === "heatmap"');
  });
});
