/**
 * `records` 컬렉션의 **DB 경계 매핑**. 출처: specs/02-data-model.md.
 *
 * specs/02가 `_id`에 달아 둔 주석이 이 파일의 존재 이유다:
 * > contracts는 DB를 모르므로 24자 hex 문자열로 표현한다.
 * > ObjectId↔string 매핑은 DB 경계(T-003/T-007)의 책임이다.
 *
 * ## 왜 여기로 올렸나 (T-008 F-4/F-6이 T-007에 넘긴 판단)
 * T-008은 "소비자가 둘이 되는 시점이 추상화의 올바른 시점"이라며 승격 판단을 미뤘고,
 * T-007이 `packages/worker/src/ingest.ts`와 **같은 매핑**을 다시 쓰게 되면서 그 시점이 왔다.
 *
 * 다만 승격한 것은 **매핑뿐이고 리포지토리가 아니다.** 두 소비자가 공유하는 것은
 * "ObjectId ↔ 24자 hex" 변환 하나뿐이고, 나머지는 겹치지 않는다 — 워커는 읽기 전용이고,
 * API는 부분 `$set`·크로스 프로젝트 가드·잡 삽입을 한다. 그 둘을 하나의 `RecordRepository`로
 * 묶으면 메서드 집합이 서로소인 파사드가 되어, 한쪽 요구가 바뀔 때마다 다른 쪽이 흔들린다.
 * **중복이 실재하는 부분만 올린다.**
 */
import type { Relation, RecordSchema } from "@sentinel/contracts";
import { ObjectId, type Collection, type Db } from "mongodb";

/** 저장된 관계. contracts는 hex 문자열, DB는 `ObjectId`다(specs/02 relations). */
export type RelationDocument = Omit<Relation, "targetRecordId"> & {
  targetRecordId: ObjectId;
};

/**
 * 저장된 레코드. contracts의 `RecordSchema`에서 파생한다 — 형상을 다시 적지 않는다(CLAUDE.md).
 * 다른 점은 식별자 표현뿐이다.
 *
 * `RecordSchema`가 판별 유니온이라 `Omit`을 그대로 쓰면 유니온이 **뭉개져** incident와
 * divergence의 필드가 한 객체에 섞인 타입이 된다. 제네릭을 한 번 경유해 분배 조건부 타입으로
 * 만들어 각 갈래를 따로 변환한다.
 */
type WithDocumentIds<R> = R extends unknown
  ? Omit<R, "_id" | "relations"> & { _id: ObjectId; relations: RelationDocument[] }
  : never;

export type RecordDocument = WithDocumentIds<RecordSchema>;

/** 타입이 붙은 `records` 컬렉션 핸들. */
export function recordsCollection(db: Db): Collection<RecordDocument> {
  return db.collection<RecordDocument>("records");
}

/**
 * 24자 hex를 `ObjectId`로. 형식이 틀리면 `undefined`를 돌려준다 —
 * **던지지 않는다.** 호출자(api)는 이걸 404/400 응답으로 번역해야 하는데,
 * 예외로 올라오면 그 분기가 500이 된다.
 */
export function toObjectId(hex: string): ObjectId | undefined {
  return ObjectId.isValid(hex) && hex.length === 24 ? new ObjectId(hex) : undefined;
}

/**
 * `_id`와 `relations[].targetRecordId`를 24자 hex로 낮춘다. 나머지 필드는 그대로 통과시킨다.
 * 반환 타입이 `unknown`인 것은 의도다 — 이 함수는 형상을 보증하지 않고,
 * 보증은 호출자가 `RecordSchema`로 파싱해서 받는다.
 */
export function toContractRecord(document: Record<string, unknown>): unknown {
  const { _id, relations, ...rest } = document;
  return {
    ...rest,
    _id: _id instanceof ObjectId ? _id.toHexString() : _id,
    relations: Array.isArray(relations) ? relations.map(toContractRelation) : relations,
  };
}

function toContractRelation(relation: unknown): unknown {
  if (typeof relation !== "object" || relation === null) return relation;
  const { targetRecordId, ...rest } = relation as { targetRecordId?: unknown };
  if (!(targetRecordId instanceof ObjectId)) return relation;
  return { ...rest, targetRecordId: targetRecordId.toHexString() };
}

/**
 * 반대 방향 — contracts의 관계를 저장 형태로 올린다.
 * `targetRecordId`가 24자 hex가 아니면 `undefined`를 돌려준다(호출자가 400으로 번역한다).
 */
export function toRelationDocuments(
  relations: readonly Relation[],
): RelationDocument[] | undefined {
  const documents: RelationDocument[] = [];
  for (const relation of relations) {
    const targetRecordId = toObjectId(relation.targetRecordId);
    if (targetRecordId === undefined) return undefined;
    documents.push({ ...relation, targetRecordId });
  }
  return documents;
}
