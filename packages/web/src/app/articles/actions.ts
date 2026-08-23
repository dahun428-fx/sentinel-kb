/**
 * 편집·발행 Server Action. specs/08 §7 "전자동 발행 금지 — 외부 공개는 사람 승인 후에만".
 *
 * ## 왜 Server Action인가
 * 이 UI에는 클라이언트 컴포넌트가 없다(T-023 규약, NFR-04: 키가 브라우저로 갈 길을 원천 차단).
 * Server Action은 `<form action={...}>`으로 붙어 **클라이언트 JS 없이도** 동작하고,
 * core-api 호출과 API 키는 서버 프로세스 안에 남는다. `fetch`를 클라이언트에서 부르면
 * 키를 브라우저로 내려보내야 하므로 그 길은 애초에 선택지가 아니다.
 *
 * ## 여기서 하지 않는 일
 * - **상태 게이트 판정**: `PATCH`는 candidate·draft에서만, 발행은 draft에서만 — 둘 다
 *   `packages/api/src/articles.ts`가 판정하고 409를 낸다. 여기서 다시 막으면 두 판정이
 *   갈라질 때 어느 쪽이 진짜인지 알 수 없게 된다. 화면의 `canEditArticle`·`canPublishArticle`은
 *   **버튼을 감추는 용도**이지 집행이 아니다.
 * - **`publishedAt` 전송**: 발행 액션은 시각을 만들지도, 받지도, 보내지도 않는다.
 *   서버가 찍는다(specs/04).
 * - **`editHistory` 작성**: 서버가 바뀐 필드로 항목을 붙인다(specs/08 §2).
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { CoreApiError, patchArticle, publishArticle } from "../../lib/api-client";
import { articleEditHref, articleHref } from "../../lib/articles";

/** 폼 필드에서 문자열 하나를 꺼낸다. 파일이 오면 무시한다(이 폼에는 파일이 없다). */
function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

/** 실패를 화면으로 되돌린다. 에러 코드를 URL에 실어 편집 화면이 사유를 보여준다. */
function failureHref(id: string, error: unknown): string {
  const code = error instanceof CoreApiError ? error.code : "UNEXPECTED_ERROR";
  return `${articleEditHref(id)}?error=${encodeURIComponent(code)}`;
}

/**
 * 본문·제목 저장. `PatchArticleInput`이 받는 필드만 보낸다 —
 * 바뀌지 않은 필드는 아예 싣지 않아 `editHistory`의 요약이 정확해진다.
 */
export async function saveArticleAction(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  if (id === undefined || id === "") throw new Error("id 없이 편집을 저장할 수 없다");

  const title = field(formData, "title");
  const body = field(formData, "body");
  const patch = {
    ...(title === undefined || title === "" ? {} : { title }),
    ...(body === undefined || body === "" ? {} : { body }),
  };

  if (Object.keys(patch).length === 0) {
    redirect(`${articleEditHref(id)}?error=VALIDATION_FAILED`);
  }

  let destination: string;
  try {
    await patchArticle(id, patch);
    destination = `${articleEditHref(id)}?saved=1`;
  } catch (error) {
    destination = failureHref(id, error);
  }

  revalidatePath(articleHref(id));
  revalidatePath("/articles");
  // `redirect`는 내부적으로 던지므로 try 밖에서 부른다 — 안에서 부르면 catch가 삼킨다.
  redirect(destination);
}

/**
 * 발행. **사람이 이 버튼을 눌러야만 실행된다** — 배치가 부를 수 있는 경로가 아니다.
 * 바디는 `publishArticle`이 `publishRequestBody()`로 만드는 빈 객체이며,
 * 이 함수는 발행 시각을 인자로 받지도 만들지도 않는다.
 */
export async function publishArticleAction(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  if (id === undefined || id === "") throw new Error("id 없이 발행할 수 없다");

  let destination: string;
  try {
    await publishArticle(id);
    destination = articleHref(id);
  } catch (error) {
    destination = failureHref(id, error);
  }

  revalidatePath(articleHref(id));
  revalidatePath("/articles");
  redirect(destination);
}
