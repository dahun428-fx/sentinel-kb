/**
 * `articles` 컬렉션 스키마 — 자동 편찬 아티클. 출처: specs/08-publishing.md §1·§2·§5.1.
 *
 * ## 왜 여기에 두는가 (T-029 판단)
 * CLAUDE.md의 금지는 "타입을 **다른 곳에** 재정의하지 않는다"이다. 아티클은 기존 타입의
 * 사본이 아니라 **새 컬렉션의 새 형상**이고, contracts 밖(worker나 api)에 두면 그 순간
 * "계약은 contracts가 단일 소스"라는 규약이 깨진다. 즉 여기 두는 것이 규약을 지키는 방향이다.
 * 기존 export를 하나도 바꾸지 않는 **순수 추가**라 breaking change(G3)도 아니다.
 *
 * ## OpenAPI (B-1에서 바뀌었다)
 * T-029는 "specs/04 표에 `/v1/articles`가 없는 이상 오퍼레이션을 등록할 근거가 없다"고 적고
 * chunks·feedbacks·eval_cases와 같은 취급(저장 스키마 전용)을 했다. specs/04 표에 아티클
 * 오퍼레이션 4건이 등재되면서 그 전제가 사라졌다 — `ArticleSchema`는 이제 `GET /v1/articles/{id}`의
 * 응답 페이로드이기도 하므로 OpenAPI에 실린다. **기존 정의는 한 줄도 바뀌지 않았고**,
 * 아래 HTTP 전용 스키마들은 전부 순수 추가다(G3 breaking change 아님).
 */
import { z } from "zod";

import { ObjectIdString } from "./common.js";

/** 아티클 유형. specs/08 §1 표의 4종. */
export const ArticleKind = z.enum(["case", "pattern", "divergence-report", "digest"]);
export type ArticleKind = z.infer<typeof ArticleKind>;

/**
 * 발행 상태. specs/08 §2.
 *
 * `candidate`는 **야간 배치가 만드는 유일한 상태**다(§1: "트리거 판정은 후보 큐에 적재만 한다").
 * `draft`는 본문 생성(T-031)이, `published`/`rejected`는 사람이 만든다.
 */
export const ArticleStatus = z.enum(["candidate", "draft", "published", "rejected"]);
export type ArticleStatus = z.infer<typeof ArticleStatus>;

/** 차트 종류. specs/08 §5.1. */
export const ChartKind = z.enum(["bar", "line", "heatmap", "timeline"]);
export type ChartKind = z.infer<typeof ChartKind>;

/**
 * 차트 선언. specs/08 §5.1: `{type, data, caption}`.
 * **LLM이 만들지 않는다** — 팩트 추출기(§3)가 DB에서 계산한 값을 담고 렌더는 web이 한다.
 * `data`를 `unknown`으로 열어 둔 것은 차트 종류마다 형상이 다르기 때문이고, 그 형상을
 * 좁히는 것은 팩트 추출기를 만드는 T-030의 몫이다.
 */
export const ChartSpec = z
  .object({
    type: ChartKind,
    data: z.unknown(),
    caption: z.string().min(1).max(300),
  })
  .strict();
export type ChartSpec = z.infer<typeof ChartSpec>;

/**
 * 사람 편집 1회. specs/08 §2 `editHistory: {at, diffSummary}[]`.
 * §0-5가 "편집 diff는 다시 스타일 개선 데이터가 된다"고 한 그 데이터다.
 */
export const ArticleEdit = z
  .object({
    at: z.date(),
    diffSummary: z.string().min(1).max(2000),
  })
  .strict();
export type ArticleEdit = z.infer<typeof ArticleEdit>;

/**
 * 저장된 아티클. specs/08 §2의 필드 목록 그대로다.
 *
 * ## 선택 필드의 근거
 * `facts`·`body`·`charts`·`lintReport`는 **candidate 단계에 존재하지 않는다.** §4의 순서가
 * `아웃라인 → 초안 → 린트 → 팩트 대조 → draft 저장`이므로, 트리거 배치(T-029)가 만드는
 * 후보에는 소스 집합과 식별자뿐이다. 이들을 필수로 잠그면 후보를 저장할 방법이 없어진다.
 *
 * ## `.refine`이 지키는 것: 전자동 발행 금지 (§0-5, §7)
 * `published`인데 본문도 발행 시각도 없는 문서는 스펙상 존재하지 않는다. 이 제약이
 * 계약에 있으면 **배치가 실수로 발행 상태를 쓰는 경로 자체가 파싱에서 막힌다** —
 * AnswerResponse가 "근거 없는 생성"을 스키마로 불가능하게 만든 것과 같은 수법이다.
 */
export const ArticleSchema = z
  .object({
    _id: ObjectIdString,
    kind: ArticleKind,
    /** 이 아티클의 재료가 된 레코드들. 중복 방지 해시의 입력이기도 하다(T-029 Scope). */
    sourceRecordIds: z.array(ObjectIdString).min(1),
    title: z.string().min(4).max(200),
    /** 발행 URL의 일부(§5.3). 컬렉션 전체에서 유일해야 한다 — unique 인덱스가 강제한다. */
    slug: z
      .string()
      .min(4)
      .max(160)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "소문자 영숫자와 하이픈만 허용한다"),
    /** §3 팩트 팩. 코드가 계산한 값이며 LLM 산출물이 아니다. T-030이 채운다. */
    facts: z.record(z.unknown()).optional(),
    /** Markdown 본문(mermaid 블록 포함). T-031이 채운다. */
    body: z.string().optional(),
    charts: z.array(ChartSpec).optional(),
    /** §4 문체 린트 결과. T-031/T-034가 채운다. */
    lintReport: z.record(z.unknown()).optional(),
    status: ArticleStatus,
    editHistory: z.array(ArticleEdit).default([]),
    createdAt: z.date(),
    publishedAt: z.date().optional(),
  })
  .strict()
  .refine(
    (article) =>
      article.status !== "published" ||
      (article.body !== undefined && article.publishedAt !== undefined),
    {
      message:
        "published 아티클은 body와 publishedAt이 있어야 한다 (specs/08 §0-5: 전자동 발행 금지)",
    },
  );
export type ArticleSchema = z.infer<typeof ArticleSchema>;

// ---------------------------------------------------------------- HTTP 표면 (B-1, specs/04 표)

/**
 * 목록 응답용 아티클 요약.
 *
 * specs/04는 "(본문 포함)"을 **단건 조회에만** 달았고, 아티클 목록 행에는
 * "**본문 없는 요약**"이라고 명시했다. 그 근거를 표 아래 블록쿼트가 다시 적는다:
 * > 목록은 본문 없는 요약이다. `GET /v1/records`가 같은 이유로 그렇다 —
 * > 본문을 목록에 실으면 NFR-03이 재발하고, `RecordSummary`를 따로 둔 이유가 무의미해진다.
 *
 * 그래서 `body`가 여기 **없다.** 함께 뺀 것들도 같은 축이다:
 * - `facts`·`lintReport`는 `z.record(z.unknown())`이라 크기 상한이 없다. 본문보다 클 수 있다.
 * - `charts`는 차트 **데이터**를 통째로 담는다(§5.1). 목록 한 페이지 20건이면 그 20배다.
 * - `editHistory`는 편집 횟수만큼 무한히 자란다.
 * - `sourceRecordIds`도 배열이라 상한이 없다 — 판단에 필요한 것은 "몇 건에서 나왔나"이므로
 *   `sourceRecordCount` 하나로 낮춘다.
 *
 * `.strict()`가 그 경계를 강제한다 — 나중에 누가 `body`를 끼워 넣으면 파싱이 실패한다.
 */
export const ArticleSummary = z
  .object({
    _id: ObjectIdString,
    kind: ArticleKind,
    title: z.string().min(4).max(200),
    slug: z.string().min(4).max(160),
    status: ArticleStatus,
    /** 본문을 싣지 않는 대신 근거의 두께를 알려주는 값. `sourceRecordIds.length`다. */
    sourceRecordCount: z.number().int().positive(),
    createdAt: z.date(),
    publishedAt: z.date().optional(),
  })
  .strict();
export type ArticleSummary = z.infer<typeof ArticleSummary>;

/**
 * 사람 편집이 지정할 수 있는 상태. **`published`가 없는 것이 요점이다.**
 *
 * specs/04는 발행을 `POST /v1/articles/:id/publish`라는 **별도 오퍼레이션**으로 두고
 * "`publishedAt`은 서버가 찍는다"고 못박았다. PATCH로 `status:"published"`를 쓸 수 있으면
 * 그 오퍼레이션을 우회하는 두 번째 발행 경로가 생기고, 그 경로에는 시각을 찍는 코드가 없다.
 * `candidate`도 없다 — 사람이 되돌릴 상태가 아니라 배치가 만드는 초기 상태다(specs/08 §1).
 */
export const ArticleEditableStatus = z.enum(["draft", "rejected"]);
export type ArticleEditableStatus = z.infer<typeof ArticleEditableStatus>;

/**
 * `PATCH /v1/articles/:id` 바디. specs/04: "편집. `candidate`·`draft`에서만 허용".
 *
 * **상태 게이트는 여기서 표현할 수 없다** — 대상 아티클의 현재 상태는 바디에 없기 때문이다.
 * 그것은 라우트가 DB를 읽고 판정한다. 계약이 막는 것은 **필드 집합**이다:
 * `publishedAt`·`project`·`_id`·`createdAt`·`facts`·`slug`는 여기 없고 `.strict()`가 거부한다.
 * 특히 `publishedAt`이 없는 것이 specs/04 블록쿼트가 말한 "세 겹 방어"의 HTTP 쪽 한 겹이다.
 *
 * `editHistory`도 없다 — 편집 기록을 편집 요청이 쓸 수 있으면 기록이 증거가 아니게 된다.
 * 서버가 바뀐 필드 목록으로 항목을 만들어 붙인다(specs/08 §2, §0-5).
 */
export const PatchArticleInput = z
  .object({
    title: z.string().min(4).max(200),
    body: z.string().min(1),
    charts: z.array(ChartSpec),
    status: ArticleEditableStatus,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "수정할 필드를 최소 1개 지정해야 한다",
  });
export type PatchArticleInput = z.infer<typeof PatchArticleInput>;

/**
 * `POST /v1/articles/:id/publish` 바디 — **빈 객체다.**
 *
 * specs/04: "발행. `publishedAt`은 **서버가 찍는다** — 클라이언트가 보내면 400".
 * 이유는 같은 블록쿼트에 있다:
 * > `ArticleSchema.refine`이 `body`·`publishedAt` 없는 `published`를 거부하는데,
 * > 클라이언트가 그 값을 보내면 **배치가 세 겹으로 막은 자동 발행 금지가 HTTP 표면에서 뚫린다.**
 *
 * 그래서 특정 키 하나를 골라 막지 않고 **아무 키도 받지 않는다.** `.strict()`가 `publishedAt`도,
 * `status`도, `project`도, 아직 존재하지 않는 미래의 필드도 한꺼번에 거부한다.
 * 발행 요청이 서버에 전달할 정보는 "이 아티클을 발행한다"뿐이고 그것은 경로에 이미 있다.
 */
export const PublishArticleInput = z.object({}).strict();
export type PublishArticleInput = z.infer<typeof PublishArticleInput>;
