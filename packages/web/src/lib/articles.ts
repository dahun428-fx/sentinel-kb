/**
 * 아티클 화면의 경로·표기·게이트. 렌더 코드가 아니라 여기 모아 단위 테스트로 고정한다
 * (T-023이 `display.ts`로 한 방식 — T-023 F-5가 "컴포넌트 렌더 회귀를 verify가 못 막는다"고
 * 지적했으므로, **잠글 수 있는 것은 순수 함수로 내려서 잠근다**).
 *
 * 타입은 전부 `@sentinel/contracts`에서 온다 — 웹에서 재정의하지 않는다(CLAUDE.md).
 *
 * ## 이 파일이 지키는 가장 중요한 것: Acceptance 3
 * "candidate 상태 아티클은 공개 목록에 노출되지 않는다."
 * **필터는 서버에 있다** — `ListArticlesQuery.status`가 `.default("published")`이고
 * `packages/api/src/articles.ts`가 그 기본값으로 조건 없이 필터를 건다.
 * 그래서 웹이 해야 할 일은 거르는 것이 아니라 **`status`를 만들지 않는 것**이다.
 * `publicArticlesPath()`가 `status`를 만들 수 있는 인자를 아예 받지 않는 이유가 그것이다.
 */
import {
  type ArticleKind,
  type ArticleStatus,
  type PublishArticleInput,
  PublishArticleInput as PublishArticleInputSchema,
} from "@sentinel/contracts";

// ---------------------------------------------------------------- core-api 경로

/** 목록 경로의 베이스. 두 경로 함수가 같은 문자열을 써야 한 쪽만 바뀌는 사고가 없다. */
const ARTICLES_PATH = "/v1/articles";

/**
 * **공개 목록 경로. `status`를 붙일 방법이 없다.**
 *
 * 인자가 `cursor` 하나뿐인 것이 이 함수의 계약이다 — 호출자가 상태를 고를 수 없으므로
 * 서버 기본값(`published`)이 그대로 적용된다. specs/04 표 아래 블록쿼트 2번:
 * > 필터를 빠뜨렸을 때의 결과가 안전한 쪽이어야 한다.
 *
 * 여기에 `status` 파라미터를 더하는 순간 `articles.spec.ts`의 "공개 목록 경로는 status를
 * 싣지 않는다"가 죽는다. 그것이 이 규칙의 관측 경로다.
 */
export function publicArticlesPath(cursor?: string): string {
  if (cursor === undefined || cursor === "") return ARTICLES_PATH;
  return `${ARTICLES_PATH}?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * 후보 큐 경로. `status`가 **필수 인자**다 — specs/04: "`status=candidate|draft`를
 * **명시해야** 후보 큐가 보인다". 명시를 타입으로 강제하면 "빠뜨림"이 불가능해진다.
 */
export function queueArticlesPath(status: QueueStatus, cursor?: string): string {
  const search = new URLSearchParams({ status });
  if (cursor !== undefined && cursor !== "") search.set("cursor", cursor);
  return `${ARTICLES_PATH}?${search.toString()}`;
}

/** 단건 조회·편집·발행이 쓰는 경로. */
export function articleResourcePath(id: string): string {
  return `${ARTICLES_PATH}/${encodeURIComponent(id)}`;
}

export function articlePublishPath(id: string): string {
  return `${articleResourcePath(id)}/publish`;
}

/**
 * `POST /v1/articles/:id/publish`의 바디를 **계약이 만들게** 한다.
 *
 * specs/04: "`publishedAt`은 **서버가 찍는다** — 클라이언트가 보내면 400".
 * 여기서 `{}`를 그냥 돌려주지 않고 `PublishArticleInput.parse`를 통과시키는 이유는,
 * 누군가 이 함수에 필드를 하나 얹었을 때 **런타임에 먼저 터지게** 하기 위해서다
 * (`PublishArticleInput`은 `.strict()`라 어떤 키도 받지 않는다).
 * `articles.spec.ts`가 이 함수의 키 집합이 비어 있음을 관측한다.
 */
export function publishRequestBody(): PublishArticleInput {
  return PublishArticleInputSchema.parse({});
}

// ---------------------------------------------------------------- 후보 큐 상태

/**
 * 후보 큐가 보여줄 수 있는 상태. **`published`가 없다** — 발행물은 공개 목록의 것이고,
 * 큐에 섞이면 "발행 대기"와 "발행됨"이 한 화면에서 구분되지 않는다.
 * **`rejected`도 없다** — 사람이 이미 내린 판단이라 대기열의 일이 아니다.
 */
export const QUEUE_STATUSES = ["candidate", "draft"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export function isQueueStatus(value: string): value is QueueStatus {
  return QUEUE_STATUSES.some((status) => status === value);
}

/**
 * `?status=`를 해석한다. 모르는 값은 400으로 튕기지 않고 **기본값으로 되돌린다** —
 * `search-params.ts`가 잘못된 `type`을 무시하는 것과 같은 판단이다(읽기 UI).
 * 기본값이 `candidate`인 것은 큐의 목적이 "아직 아무도 안 본 후보"이기 때문이다.
 */
export function parseQueueStatus(raw: string | string[] | undefined): QueueStatus {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed !== undefined && isQueueStatus(trimmed) ? trimmed : "candidate";
}

/** `?cursor=`를 해석한다. 빈 문자열은 커서 없음과 같다. */
export function parseCursor(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

// ---------------------------------------------------------------- 편집·발행 게이트

/**
 * 편집 화면을 열어도 되는가. specs/04: "편집. `candidate`·`draft`에서만 허용".
 *
 * **서버가 최종 판정자다**(`packages/api/src/articles.ts`가 409를 낸다). 이 함수는
 * 사람에게 못 누를 버튼을 보여주지 않기 위한 두 번째 겹이며, `published`에 편집이
 * 열리면 독자가 읽은 것과 저장된 것이 갈라진다.
 */
export function canEditArticle(status: ArticleStatus): boolean {
  return status === "candidate" || status === "draft";
}

/**
 * 발행 버튼을 보여도 되는가. `packages/api/src/articles.ts`의 `PUBLISHABLE_STATUSES`와
 * `ArticleSchema.refine`을 화면 쪽에서 미리 반영한다: **`draft`이고 본문이 있을 때만.**
 * candidate 발행은 "아무도 쓰지 않은 글을 내보내는 것"이다(specs/08 §4).
 */
export function canPublishArticle(article: {
  readonly status: ArticleStatus;
  readonly body?: string | undefined;
}): boolean {
  return article.status === "draft" && article.body !== undefined && article.body.trim() !== "";
}

/** 발행할 수 없는 이유. 버튼을 감추기만 하면 왜 못 누르는지 아무도 모른다. */
export function publishBlockReason(article: {
  readonly status: ArticleStatus;
  readonly body?: string | undefined;
}): string | null {
  if (canPublishArticle(article)) return null;
  if (article.status === "published") return "이미 발행된 아티클이다.";
  if (article.status === "rejected") return "사람이 반려한 아티클이다. 되돌리려면 새 후보가 나야 한다.";
  if (article.status === "candidate") {
    return "후보 상태다. 본문 초안이 만들어진 draft에서만 발행할 수 있다(specs/08 §4).";
  }
  return "본문이 비어 있다. 본문 없는 발행은 계약이 거부한다(specs/08 §0-5).";
}

// ---------------------------------------------------------------- 화면 경로

export function articleHref(id: string): string {
  return `/articles/${encodeURIComponent(id)}`;
}

export function articleEditHref(id: string): string {
  return `${articleHref(id)}/edit`;
}

export function articleExportHref(id: string): string {
  return `${articleHref(id)}/export`;
}

export function articleQueueHref(status: QueueStatus): string {
  return `/articles/queue?status=${status}`;
}

/** 공개 목록의 다음 페이지 링크. 여기에도 `status`는 없다. */
export function publicArticlesHref(cursor?: string): string {
  return cursor === undefined || cursor === ""
    ? "/articles"
    : `/articles?cursor=${encodeURIComponent(cursor)}`;
}

// ---------------------------------------------------------------- 라벨

const STATUS_LABELS: Record<ArticleStatus, string> = {
  candidate: "후보",
  draft: "초안",
  published: "발행됨",
  rejected: "반려",
};

export function articleStatusLabel(status: ArticleStatus): string {
  return STATUS_LABELS[status];
}

const KIND_LABELS: Record<ArticleKind, string> = {
  case: "케이스 스터디",
  pattern: "패턴",
  "divergence-report": "이격 리포트",
  digest: "다이제스트",
};

export function articleKindLabel(kind: ArticleKind): string {
  return KIND_LABELS[kind];
}

/** 서버·클라이언트 타임존 차이로 하이드레이션이 흔들리지 않게 UTC 고정 포맷을 쓴다. */
export function formatArticleDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 근거의 두께. 목록이 본문을 싣지 않는 대신 보여주는 값이다(`ArticleSummary`). */
export function sourceCountLabel(count: number): string {
  return `소스 ${String(count)}건`;
}

// ---------------------------------------------------------------- 편집 실패 표기

/**
 * core-api 에러 코드를 사람 문장으로. 코드는 SCREAMING_SNAKE다(specs/04 규약).
 * 모르는 코드는 감추지 않고 그대로 보여준다 — 조용히 삼키면 실패가 성공처럼 보인다.
 */
const EDIT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ARTICLE_NOT_EDITABLE: "이 아티클은 편집할 수 없는 상태다. candidate·draft에서만 편집된다.",
  ARTICLE_NOT_PUBLISHABLE: "발행할 수 없는 상태다. 본문이 있는 draft에서만 발행된다.",
  ARTICLE_NOT_FOUND: "아티클을 찾지 못했다.",
  PUBLISHED_AT_IS_SERVER_OWNED: "발행 시각은 서버가 찍는다. 클라이언트가 보낼 수 없다.",
  VALIDATION_FAILED: "입력이 계약을 만족하지 않는다.",
  CORE_API_UNREACHABLE: "core-api에 접속하지 못했다.",
};

export function editErrorMessage(code: string): string {
  return EDIT_ERROR_MESSAGES[code] ?? `요청이 실패했다 (코드: ${code}).`;
}
