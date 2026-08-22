/**
 * T-023 Acceptance 1: 검색→상세 이동 / 필터 적용 / 인용 점프.
 * 여기에 Acceptance 2(클라이언트 번들에 API 키 없음)의 실산출물 검사를 한 건 더 붙인다 —
 * 소스 단위 봉쇄는 `src/client-safety.spec.ts`가 이미 지키고, 이쪽은 실제로 브라우저에
 * 내려간 바이트를 본다.
 */
import { expect, test } from "@playwright/test";

import {
  CANARY_API_KEY,
  DIVERGENCE_ID,
  DIVERGENCE_TITLE,
  INCIDENT_ID,
  INCIDENT_TITLE,
} from "./fixtures";

test("검색 결과에서 레코드 상세로 이동한다", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("질의").fill("웹훅 타임아웃");
  await page.getByRole("button", { name: "검색" }).click();

  const results = page.getByTestId("result-list").getByRole("listitem");
  await expect(results).toHaveCount(2);

  // 점수는 순위로 읽힌다. 백분율 표기는 어디에도 없어야 한다(RRF 상한이 2/61 ≈ 0.0328).
  await expect(results.first()).toContainText("1위");
  await expect(results.first()).toContainText("RRF 0.0328");
  await expect(page.getByTestId("result-list")).not.toContainText("%");

  await page.getByTestId("result-link").first().click();

  await expect(page).toHaveURL(new RegExp(`/records/${INCIDENT_ID}`));
  await expect(page.getByTestId("record-title")).toHaveText(INCIDENT_TITLE);
  await expect(page.getByRole("heading", { name: "해결 절차" })).toBeVisible();
});

test("종류 필터가 결과를 좁히고 인젝션 의심 기록은 경고와 함께 노출된다", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("질의").fill("웹훅 타임아웃");
  await page.getByLabel("종류").selectOption("divergence");
  await page.getByRole("button", { name: "검색" }).click();

  await expect(page).toHaveURL(/type=divergence/);

  const results = page.getByTestId("result-list").getByRole("listitem");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText(DIVERGENCE_TITLE);
  await expect(page.getByTestId("result-type")).toHaveText("이격");

  // specs/03 §2: injection-suspect는 감추지 않고 경고와 함께 보여준다.
  await expect(results.first().getByRole("note")).toContainText("인젝션 의심");
});

test("답변의 인용을 누르면 해당 레코드의 해당 섹션으로 점프한다", async ({ page }) => {
  await page.goto("/answer?q=웹훅 타임아웃");

  await expect(page.getByTestId("answer-body")).not.toBeEmpty();

  const citation = page.getByTestId("citation-link").first();
  await expect(citation).toContainText("해결 절차");
  await citation.click();

  await expect(page).toHaveURL(`/records/${INCIDENT_ID}#section-resolution`);
  await expect(page.locator("#section-resolution")).toBeVisible();
  await expect(page.locator("#section-resolution")).toContainText("큐로 분리");
});

test("클라이언트로 내려간 어떤 바이트에도 API 키가 없다", async ({ page }) => {
  const downloaded: string[] = [];
  page.on("response", (response) => {
    const contentType = response.headers()["content-type"] ?? "";
    if (/javascript|html|json/.test(contentType)) {
      downloaded.push(response.url());
    }
  });

  await page.goto(`/records/${DIVERGENCE_ID}`);
  await page.goto("/?q=웹훅 타임아웃");
  await page.waitForLoadState("networkidle");

  expect(downloaded.length).toBeGreaterThan(0);

  for (const url of downloaded) {
    const body = await page.request.get(url).then(async (res) => res.text());
    expect(body, `${url}에 카나리 키가 실렸다`).not.toContain(CANARY_API_KEY);
    expect(body, `${url}에 키 환경변수 이름이 실렸다`).not.toContain("CORE_API_KEY");
  }
});
