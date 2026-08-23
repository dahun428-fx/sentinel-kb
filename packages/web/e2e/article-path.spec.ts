/**
 * T-033 Acceptance 1·2·3의 E2E. `pnpm verify` **밖**이다(T-023 규약: 브라우저를 띄우는
 * 검사를 머지 게이트에 넣으면 루프가 느려진다). 실행은
 * `pnpm --filter @sentinel/web test:e2e`.
 *
 * ## 이 파일이 재는 것과 재지 않는 것
 * **재는 것**: 웹의 흐름 — 큐에서 초안을 열고, 고치고, 사람이 발행 버튼을 눌렀을 때
 * 공개 목록에 나타나는가. 그리고 본문이 어떤 경우에도 마크업이 되지 않는가.
 * **재지 않는 것**: `status` 필터의 서버 판정. 그건 `packages/api`의 몫이고, 여기서
 * 스텁을 상대로 재면 스텁 자신을 재는 것이 된다(T-031 F-7이 지적한 자기충족).
 * 웹 쪽 관측은 `src/lib/articles.spec.ts`(경로에 status가 없다)와
 * `src/articles-safety.spec.ts`(공개 목록이 큐 호출을 모른다)가 담당한다.
 */
import { expect, test } from "@playwright/test";

import {
  CANDIDATE_ARTICLE_TITLE,
  DRAFT_ARTICLE_TITLE,
  FLOW_DRAFT_ARTICLE_ID,
  FLOW_DRAFT_ARTICLE_TITLE,
  PUBLISHED_ARTICLE_ID,
  PUBLISHED_ARTICLE_TITLE,
} from "./fixtures";

test.describe("아티클 읽기 경로", () => {
  test("공개 목록에는 발행물만 있다 — 후보·초안 제목이 없다", async ({ page }) => {
    await page.goto("/articles");
    await expect(page.getByTestId("article-list")).toContainText(PUBLISHED_ARTICLE_TITLE);
    await expect(page.locator("body")).not.toContainText(CANDIDATE_ARTICLE_TITLE);
    await expect(page.locator("body")).not.toContainText(DRAFT_ARTICLE_TITLE);
  });

  test("상세에 차트 3종이 그려진다", async ({ page }) => {
    await page.goto(`/articles/${PUBLISHED_ARTICLE_ID}`);
    await expect(page.locator('[data-chart-kind="bar"] svg')).toBeVisible();
    await expect(page.locator('[data-chart-kind="line"] svg')).toBeVisible();
    await expect(page.locator('[data-chart-kind="heatmap"] svg')).toBeVisible();
  });

  test("mermaid는 원문 코드로 나오고 다이어그램 SVG가 되지 않는다 (F-2)", async ({ page }) => {
    await page.goto(`/articles/${PUBLISHED_ARTICLE_ID}`);
    const source = page.getByTestId("mermaid-source");
    await expect(source).toContainText("flowchart TD");
    // 다이어그램으로 렌더됐다면 mermaid가 만든 svg가 이 블록 안에 있었을 것이다.
    await expect(page.getByTestId("mermaid-block").locator("svg")).toHaveCount(0);
  });

  test("본문의 HTML·javascript: 링크가 실행되지 않는다", async ({ page }) => {
    await page.goto(`/articles/${PUBLISHED_ARTICLE_ID}`);
    // 스크립트 태그는 글자로 보인다.
    await expect(page.getByTestId("article-body")).toContainText("<script>");
    await expect(page.evaluate(() => "__pwned" in window)).resolves.toBe(false);
    // 위험한 스킴은 링크가 되지 않는다 — 허용된 링크만 앵커다.
    const hrefs = await page.getByTestId("article-body").locator("a").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? ""),
    );
    expect(hrefs.some((href) => href.toLowerCase().startsWith("javascript:"))).toBe(false);
    expect(hrefs).toContain("https://example.com/webhook");
  });
});

test.describe("Acceptance 1: draft 편집 → 발행 → 목록 노출", () => {
  test("사람이 초안을 고치고 발행하면 공개 목록에 나타난다", async ({ page }) => {
    // 1) 후보 큐에서 초안을 찾는다 — 공개 목록에는 없다.
    await page.goto("/articles/queue?status=draft");
    await expect(page.getByTestId("queue-list")).toContainText(FLOW_DRAFT_ARTICLE_TITLE);

    // 2) 편집 화면에서 본문을 고친다.
    await page.goto(`/articles/${FLOW_DRAFT_ARTICLE_ID}/edit`);
    await expect(page.getByTestId("edit-form")).toBeVisible();
    await page.getByLabel("본문 (Markdown)").fill("# 고친 본문\n\n사람이 손을 댔다.");
    await page.getByTestId("save-article").click();
    await expect(page.getByTestId("saved-notice")).toBeVisible();

    /*
     * 3) 사람이 발행 버튼을 누른다.
     * 우리가 넣은 입력은 `id` 하나뿐이다 — 발행 시각을 담을 자리가 없다(specs/04).
     * Next가 Server Action 폼에 자기 히든 필드(`$ACTION_*`)를 하나 더 붙이므로 그것은 제외한다.
     */
    const ourInputs = await page
      .getByTestId("publish-form")
      .locator("input")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute("name") ?? "")
          .filter((name) => !name.startsWith("$ACTION")),
      );
    expect(ourInputs).toEqual(["id"]);
    await page.getByTestId("publish-article").click();

    // 4) 상세가 발행 상태로 바뀌고, 공개 목록에 나타난다.
    await expect(page.getByTestId("article-status")).toHaveText("발행됨");
    await page.goto("/articles");
    await expect(page.getByTestId("article-list")).toContainText(FLOW_DRAFT_ARTICLE_TITLE);
  });

  test("발행된 아티클에는 편집 폼이 열리지 않는다", async ({ page }) => {
    await page.goto(`/articles/${PUBLISHED_ARTICLE_ID}/edit`);
    await expect(page.getByTestId("not-editable")).toBeVisible();
    await expect(page.getByTestId("edit-form")).toHaveCount(0);
    await expect(page.getByTestId("publish-form")).toHaveCount(0);
  });

  test("후보는 본문이 없어 발행 버튼이 열리지 않는다", async ({ page }) => {
    await page.goto("/articles/queue?status=candidate");
    await expect(page.getByTestId("queue-list")).toContainText(CANDIDATE_ARTICLE_TITLE);
    await page.getByTestId("to-edit").first().click();
    await expect(page.getByTestId("not-publishable")).toBeVisible();
  });
});

test.describe("단일 HTML 내보내기", () => {
  test("혼자서도 읽히는 HTML 문서를 돌려준다", async ({ page }) => {
    const response = await page.request.get(`/articles/${PUBLISHED_ARTICLE_ID}/export`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(PUBLISHED_ARTICLE_TITLE);
    // 본문의 스크립트 태그는 이스케이프되어 실행 가능한 마크업이 아니다.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>window.__pwned");
  });
});
