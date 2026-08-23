/**
 * `articles` 컬렉션의 **DB 경계 매핑**. 출처: specs/08-publishing.md §1·§2.
 *
 * ## 왜 worker에서 여기로 올렸나 (B-1)
 * T-029가 이 매핑을 `packages/worker/src/articles.ts`에 뒀다. 그때는 소비자가 야간 배치
 * 하나였으므로 옳은 자리였다. specs/04 표에 아티클 오퍼레이션 4건이 등재되면서 두 번째
 * 소비자(`packages/api`)가 생겼고, `api → worker`는 **형제 간선이라 lint가 막는다**
 * (specs/01의 의존 방향, `tools/dependency-boundaries.spec.ts`). api 쪽에 같은 타입을 다시
 * 적는 것은 CLAUDE.md의 "타입을 다른 곳에 재정의하지 않는다"를 정면으로 어긴다.
 * 즉 **올리는 것이 유일하게 규약을 지키는 경로**다.
 *
 * `records.ts`가 T-008→T-007에서 같은 판단을 같은 근거로 했다: 소비자가 둘이 되는 시점이
 * 승격의 시점이고, 승격하는 것은 **매핑뿐이지 리포지토리가 아니다.** 트리거 배치 고유의
 * 멱등 키(`articleId`)와 슬러그 생성은 worker에 그대로 남는다 — 소비자가 여전히 하나다.
 */
import type { ArticleSchema } from "@sentinel/contracts";
import { ObjectId, type Collection, type Db } from "mongodb";

/**
 * 저장된 아티클. contracts의 `ArticleSchema`에서 파생하며 다른 점은 식별자 표현뿐이다.
 * (`ArticleSchema`가 `.refine`을 달아 `ZodEffects`라 `z.infer`는 그대로 객체 타입이다.)
 */
export type ArticleDocument = Omit<ArticleSchema, "_id" | "sourceRecordIds"> & {
  _id: ObjectId;
  sourceRecordIds: ObjectId[];
};

/** 타입이 붙은 `articles` 컬렉션 핸들. */
export function articlesCollection(db: Db): Collection<ArticleDocument> {
  return db.collection<ArticleDocument>("articles");
}

/**
 * `_id`와 `sourceRecordIds`를 24자 hex로 낮춘다. 나머지 필드는 그대로 통과시킨다.
 *
 * 반환 타입이 `unknown`인 것은 `toContractRecord`와 같은 의도다 — 이 함수는 형상을
 * 보증하지 않고, 보증은 호출자가 `ArticleSchema`로 파싱해서 받는다. 여기서 형상을
 * 약속하면 `.refine`(전자동 발행 금지)이 두 곳에서 검사되는 것처럼 보이게 된다.
 */
export function toContractArticle(document: Record<string, unknown>): unknown {
  const { _id, sourceRecordIds, ...rest } = document;
  return {
    ...rest,
    ...(_id instanceof ObjectId ? { _id: _id.toHexString() } : { _id }),
    ...(Array.isArray(sourceRecordIds)
      ? {
          sourceRecordIds: sourceRecordIds.map((id) =>
            id instanceof ObjectId ? id.toHexString() : id,
          ),
        }
      : { sourceRecordIds }),
  };
}
