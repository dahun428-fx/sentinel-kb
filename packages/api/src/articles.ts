/**
 * `/v1/articles` 라우트. 출처: specs/04-api.md 표(아티클 4건), specs/08-publishing.md §0-5·§2·§7.
 *
 * 검증은 **contracts의 Zod 스키마로만** 한다 — 타입도 제약도 여기서 다시 정의하지 않는다(CLAUDE.md).
 * 이 파일이 하는 일은 계약이 표현하지 못하는 **서버 소유 규칙**뿐이다:
 *   - 목록의 기본 `status`는 `published`다 (계약의 기본값을 그대로 쓴다)
 *   - `publishedAt`은 **서버가 찍는다**. 클라이언트 값은 400으로 거부한다 (specs/04)
 *   - 편집은 `candidate`·`draft`에서만 (specs/04)
 *   - 발행은 `draft`에서, 본문이 있을 때만 (specs/08 §0-5)
 *   - `editHistory`는 서버가 붙인다 (specs/08 §2)
 *
 * ## 이 라우트가 절대 하지 않는 일 — T-029가 세운 방어선의 HTTP 쪽 한 겹
 * `article-batch.ts`가 세 겹으로 자동 발행을 막았다: 배치가 `status:"candidate"`만 쓰고,
 * `$setOnInsert`로 기존 문서를 건드리지 않고, `ArticleSchema.refine`이 `body`·`publishedAt`
 * 없는 `published`를 거부한다. **HTTP 표면은 그 세 겹을 우회할 수 있는 유일한 경로**이므로
 * 여기서 발행 시각을 클라이언트에게서 받지 않는 것이 그 방어선을 잇는 일이다.
 *
 * ## `project`에 대하여 (B-1이 명시적으로 남기는 판단)
 * specs/04 규약은 "크로스 조회 허용, 쓰기는 자기 project로만"이지만 **`articles`에는 `project`
 * 필드가 없다**(specs/08 §2, `ArticleSchema`). 아티클은 여러 project의 레코드를 가로질러
 * 편찬되는 집계물이라(§3이 `facts`에 "프로젝트 분포"를 넣는다) 소유 project라는 개념이 애초에 없다.
 * 그래서 여기서 강제할 수 있는 것은 규약의 **한쪽 절반**뿐이다: 바디의 `project`를 조용히
 * 무시하지 않고 400으로 거부하는 것(confused deputy 방지). 나머지 절반(소유권 대조)은 필드가
 * 생기기 전에는 구현할 수 없고, 없는 필드로 흉내 내면 검사하지 않는 것을 검사한다고 말하게 된다.
 */
import {
  ArticleIdParam,
  ArticleSchema,
  ArticleSummary,
  ListArticlesQuery,
  PatchArticleInput,
  PublishArticleInput,
} from "@sentinel/contracts";
import {
  articlesCollection,
  toContractArticle,
  toObjectId,
  type ArticleDocument,
} from "@sentinel/core/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db, Filter, ObjectId } from "mongodb";

import { decodeCursor, encodeCursor } from "./cursor.js";
import { API_ERROR_CODES, HttpError } from "./errors.js";

export interface ArticleRoutesDeps {
  readonly db: Db;
  /** 시계 주입. **`publishedAt`이 여기서 나온다** — 테스트가 발행 시각을 결정론적으로 봐야 한다. */
  readonly now: () => Date;
}

/** specs/04: 편집이 허용되는 상태. 이 둘 밖은 409다. */
const EDITABLE_STATUSES = ["candidate", "draft"] as const;

/**
 * 발행이 허용되는 상태. **`candidate`가 없다.**
 *
 * specs/04 표는 발행의 출발 상태를 적지 않았고, specs/08 §4의 파이프라인이 그것을 정한다:
 * `... → draft 저장 → [사람 편집·발행]`. 본문은 draft 단계에서 생기므로(§4) `candidate`를
 * 발행한다는 것은 **아무도 쓰지 않은 글을 내보내는 것**이다. 표가 침묵하는 곳에서는 좁은 쪽을
 * 고른다 — 목록 기본값을 `published`로 둔 것과 같은 판단이다(빠뜨렸을 때가 안전한 쪽).
 */
const PUBLISHABLE_STATUSES = ["draft"] as const;

// ---------------------------------------------------------------- 공통 헬퍼

/**
 * 바디에 서버 소유 필드가 왔는지 **먼저** 본다. `records.ts`의 `assertNoServerOwnedKeys`와 같은 축이며,
 * 근거도 같다: `.strict()`의 "Unrecognized key(s)"는 무엇이 왜 문제인지 알려주지 않는다.
 */
function assertNoServerOwnedArticleKeys(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const keys = Object.keys(body);

  if (keys.includes("publishedAt")) {
    throw new HttpError(
      400,
      API_ERROR_CODES.PUBLISHED_AT_IS_SERVER_OWNED,
      "바디에 `publishedAt`을 담을 수 없다. 발행 시각은 서버가 찍는다(specs/04). " +
        "클라이언트가 이 값을 정할 수 있으면 specs/08 §0-5의 전자동 발행 금지가 HTTP 표면에서 뚫린다.",
    );
  }
  if (keys.includes("project")) {
    throw new HttpError(
      400,
      API_ERROR_CODES.PROJECT_NOT_ALLOWED_IN_BODY,
      "바디에 `project`를 담을 수 없다. project는 인증 키의 클레임에서 해석되며 " +
        "바디 값은 무시되지 않고 거부된다(specs/04). 무시는 confused deputy를 만든다.",
    );
  }
}

/** Zod 실패를 400으로 옮긴다. issue 목록을 `details`에 실어 클라이언트가 필드를 특정할 수 있게 한다. */
function validationError(error: { issues: unknown }): HttpError {
  return new HttpError(
    400,
    API_ERROR_CODES.VALIDATION_FAILED,
    "요청이 스키마를 만족하지 않는다.",
    error.issues,
  );
}

/** DB 도큐먼트를 contracts 형상으로 낮춰 파싱한다. 통과하지 못하면 저장된 도큐먼트가 깨진 것이다. */
function toContractArticleOrThrow(document: ArticleDocument): ArticleSchema {
  const parsed = ArticleSchema.safeParse(toContractArticle({ ...document }));
  if (!parsed.success) {
    throw new Error(`저장된 아티클이 ArticleSchema를 만족하지 않는다: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * 목록 항목. `ArticleSummary`가 `.strict()`라 본문 필드를 실으면 파싱이 실패한다(NFR-03).
 *
 * **필드를 하나씩 옮겨 담는 것이 요점이다.** `{...document}`를 넘기면 `body`·`facts`·
 * `charts`·`lintReport`가 통째로 딸려오고, `.strict()`가 잡아 주기는 하지만 그것은
 * "런타임에 500으로 터진다"는 뜻이지 요약이 된다는 뜻이 아니다.
 */
function toSummaryItem(document: ArticleDocument): ArticleSummary {
  return ArticleSummary.parse({
    _id: document._id.toHexString(),
    kind: document.kind,
    title: document.title,
    slug: document.slug,
    status: document.status,
    sourceRecordCount: document.sourceRecordIds.length,
    createdAt: document.createdAt,
    ...(document.publishedAt === undefined ? {} : { publishedAt: document.publishedAt }),
  });
}

/** 경로 파라미터를 검증하고 아티클을 읽는다. 형식 오류는 400, 없으면 404. */
async function loadArticle(
  articles: ReturnType<typeof articlesCollection>,
  params: unknown,
): Promise<ArticleDocument> {
  const parsed = ArticleIdParam.safeParse(params);
  if (!parsed.success) throw validationError(parsed.error);

  // `ObjectIdString`이 이미 24자 hex를 강제하므로 여기서 실패할 수 없다.
  // 그래도 `toObjectId`가 `undefined`를 낼 수 있는 계약이라 분기를 남긴다.
  const id: ObjectId | undefined = toObjectId(parsed.data.id);
  if (id === undefined) {
    throw new HttpError(
      400,
      API_ERROR_CODES.VALIDATION_FAILED,
      "id가 24자 hex ObjectId 문자열이 아니다.",
    );
  }

  const document = await articles.findOne({ _id: id });
  if (document === null) {
    throw new HttpError(404, API_ERROR_CODES.ARTICLE_NOT_FOUND, `아티클 ${parsed.data.id}가 없다.`);
  }
  return document;
}

/** 병합 결과가 계약을 만족하는지 **쓰기 전에** 본다. `.refine`(전자동 발행 금지)이 여기서 돈다. */
function assertMergedArticleValid(
  existing: ArticleDocument,
  patch: Readonly<Record<string, unknown>>,
  code: "edit" | "publish",
): void {
  const merged = {
    ...(toContractArticle({ ...existing }) as Record<string, unknown>),
    ...patch,
  };
  const validated = ArticleSchema.safeParse(merged);
  if (validated.success) return;

  throw new HttpError(
    400,
    code === "edit" ? API_ERROR_CODES.VALIDATION_FAILED : API_ERROR_CODES.ARTICLE_NOT_PUBLISHABLE,
    "요청 결과가 아티클 스키마를 벗어났다.",
    validated.error.issues,
  );
}

/**
 * 사람 편집 1회의 요약. specs/08 §2 `editHistory: {at, diffSummary}[]`.
 *
 * **서버가 만든다.** 클라이언트가 넣을 수 있으면 편집 기록이 증거가 아니라 주장이 되고,
 * §0-5가 "편집 diff는 다시 스타일 개선 데이터가 된다"고 한 그 데이터가 오염된다.
 * 바뀐 필드 이름만 담는다 — 본문 diff 전체를 담으면 문서가 편집 횟수만큼 본문 배수로 자란다.
 */
function editSummary(patch: Readonly<Record<string, unknown>>): string {
  return `${Object.keys(patch).sort().join(", ")} 수정`;
}

// ---------------------------------------------------------------- 라우트

export function registerArticleRoutes(app: FastifyInstance, deps: ArticleRoutesDeps): void {
  const articles = articlesCollection(deps.db);

  // ------------------------------------------------------------ GET /v1/articles
  app.get("/v1/articles", async (request, reply): Promise<FastifyReply> => {
    const parsed = ListArticlesQuery.safeParse(request.query);
    if (!parsed.success) throw validationError(parsed.error);
    const query = parsed.data;

    /**
     * **필터를 항상 건다.** `query.status`는 계약이 기본값을 주므로 절대 `undefined`가 아니고,
     * 그래서 "status를 안 주면 전체가 나오는" 분기가 이 함수에 존재하지 않는다.
     * specs/04: "기본은 `published`만. `status=candidate|draft`를 명시해야 후보 큐가 보인다."
     * 조건부로 감싸는 순간(`if (query.status !== undefined)`) 계약의 기본값을 지우기만 하면
     * 미발행 초안이 공개 목록에 뜬다 — 그래서 조건문을 두지 않는다.
     */
    const filter: Filter<ArticleDocument> = { status: query.status };

    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (cursor === undefined) {
        throw new HttpError(
          400,
          API_ERROR_CODES.INVALID_CURSOR,
          "cursor가 이 서버가 발급한 형식이 아니다. 응답의 `nextCursor`를 그대로 돌려줘야 한다.",
        );
      }
      // `createdAt` 단독으로는 같은 밀리초의 아티클이 경계에서 사라진다 — `_id`가 동점 처리자다.
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ];
    }

    // 다음 페이지 존재 여부를 알기 위해 하나 더 읽는다(`records.ts`와 같은 방식).
    const documents = await articles
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();

    const page = documents.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      documents.length > query.limit && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last._id })
        : null;

    return reply.send({ items: page.map(toSummaryItem), nextCursor });
  });

  // ------------------------------------------------------------ GET /v1/articles/:id
  app.get("/v1/articles/:id", async (request, reply): Promise<FastifyReply> => {
    const document = await loadArticle(articles, request.params);
    // 크로스 project **조회**는 허용이다(specs/04). 아티클에는 소유 project 자체가 없다.
    return reply.send(toContractArticleOrThrow(document));
  });

  // ------------------------------------------------------------ PATCH /v1/articles/:id
  app.patch("/v1/articles/:id", async (request, reply): Promise<FastifyReply> => {
    assertNoServerOwnedArticleKeys(request.body);

    const parsed = PatchArticleInput.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const patch: Record<string, unknown> = parsed.data;

    const existing = await loadArticle(articles, request.params);

    /**
     * specs/04: "편집. `candidate`·`draft`에서만 허용".
     * 발행된 글을 조용히 고치면 독자가 읽은 것과 저장된 것이 갈라지고, `rejected`를 고치는 것은
     * 사람이 내린 판단을 지우는 것이다. 되돌리려면 새 후보가 나야 한다(§1의 억제 규칙이 그 길을 연다).
     */
    if (!EDITABLE_STATUSES.some((status) => status === existing.status)) {
      throw new HttpError(
        409,
        API_ERROR_CODES.ARTICLE_NOT_EDITABLE,
        `상태가 "${existing.status}"인 아티클은 편집할 수 없다. ` +
          "편집은 candidate·draft에서만 허용된다(specs/04).",
        { status: existing.status },
      );
    }

    const now = deps.now();
    assertMergedArticleValid(existing, patch, "edit");

    const updated = await articles.findOneAndUpdate(
      // 필터에 상태를 다시 건다. 위 409 검사와 이중이지만, 검사와 쓰기 사이에 아티클이
      // 바뀔 수 있고(다른 요청이 발행) 그 창을 닫는 것은 필터뿐이다 — `records.ts`와 같은 수법.
      { _id: existing._id, status: { $in: [...EDITABLE_STATUSES] } },
      {
        $set: patch,
        // specs/08 §2. `$push`라 기존 항목을 덮지 않는다 — 편집 기록은 누적만 된다.
        $push: { editHistory: { at: now, diffSummary: editSummary(patch) } },
      },
      { returnDocument: "after" },
    );
    if (updated === null) {
      throw new HttpError(
        409,
        API_ERROR_CODES.ARTICLE_NOT_EDITABLE,
        "편집하는 사이에 아티클의 상태가 바뀌었다.",
      );
    }

    return reply.send(toContractArticleOrThrow(updated));
  });

  // ------------------------------------------------------------ POST /v1/articles/:id/publish
  app.post("/v1/articles/:id/publish", async (request, reply): Promise<FastifyReply> => {
    assertNoServerOwnedArticleKeys(request.body);

    /**
     * 바디는 **빈 객체**여야 한다. 바디를 아예 보내지 않는 것도 정상이므로 `{}`로 낮춘다 —
     * 그러지 않으면 `undefined`가 스키마를 통과하지 못해 "바디 없이 발행"이 400이 된다.
     * `.strict()`가 `publishedAt`을 포함한 **모든** 키를 거부하고, `publishedAt`만은
     * 위 `assertNoServerOwnedArticleKeys`가 먼저 잡아 전용 코드로 알린다.
     */
    const parsed = PublishArticleInput.safeParse(request.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);

    const existing = await loadArticle(articles, request.params);

    if (!PUBLISHABLE_STATUSES.some((status) => status === existing.status)) {
      throw new HttpError(
        409,
        API_ERROR_CODES.ARTICLE_NOT_PUBLISHABLE,
        `상태가 "${existing.status}"인 아티클은 발행할 수 없다. 발행은 draft에서만 가능하다 — ` +
          "본문은 초안 단계에서 생기므로(specs/08 §4) candidate 발행은 아무도 쓰지 않은 글을 내보내는 것이다.",
        { status: existing.status },
      );
    }

    /**
     * **발행 시각을 여기서 찍는다.** specs/04: "`publishedAt`은 서버가 찍는다".
     * 이 한 줄이 클라이언트 입력이 아니라 주입된 시계에서 나오는 것이 계약의 전부다.
     */
    const publishedAt = deps.now();
    const patch = { status: "published", publishedAt } as const;

    // `ArticleSchema.refine`이 여기서 돈다 — 본문 없는 published는 이 검사에서 걸린다.
    // 상태 게이트(draft만)와 이중이지만, `.refine`은 **본문 유무**를 보고 게이트는 상태를 본다.
    assertMergedArticleValid(existing, patch, "publish");

    const updated = await articles.findOneAndUpdate(
      // 검사와 쓰기 사이에 다른 요청이 발행하는 창을 닫는다. 두 번째 요청은 여기서 null을 받는다.
      { _id: existing._id, status: { $in: [...PUBLISHABLE_STATUSES] } },
      { $set: patch },
      { returnDocument: "after" },
    );
    if (updated === null) {
      throw new HttpError(
        409,
        API_ERROR_CODES.ARTICLE_NOT_PUBLISHABLE,
        "발행하는 사이에 아티클의 상태가 바뀌었다.",
      );
    }

    return reply.send(toContractArticleOrThrow(updated));
  });
}
