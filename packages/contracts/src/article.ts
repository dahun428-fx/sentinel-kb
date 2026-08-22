/**
 * `articles` 컬렉션 스키마 — 자동 편찬 아티클. 출처: specs/08-publishing.md §1·§2·§5.1.
 *
 * ## 왜 여기에 두는가 (T-029 판단)
 * CLAUDE.md의 금지는 "타입을 **다른 곳에** 재정의하지 않는다"이다. 아티클은 기존 타입의
 * 사본이 아니라 **새 컬렉션의 새 형상**이고, contracts 밖(worker나 api)에 두면 그 순간
 * "계약은 contracts가 단일 소스"라는 규약이 깨진다. 즉 여기 두는 것이 규약을 지키는 방향이다.
 * 기존 export를 하나도 바꾸지 않는 **순수 추가**라 breaking change(G3)도 아니다.
 *
 * ## OpenAPI에는 싣지 않는다
 * chunks·feedbacks·eval_cases와 같은 취급이다 — HTTP 페이로드가 아니라 **저장 스키마**다.
 * specs/04 표에 `/v1/articles`가 없는 이상 오퍼레이션을 등록할 근거가 없다(T-029 STATUS 참조).
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
