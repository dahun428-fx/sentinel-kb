/**
 * 아티클의 **결정론적 식별자**와 슬러그. 출처: specs/08-publishing.md §1·§2.
 *
 * 형상은 contracts의 `ArticleSchema`가 소유한다 — 여기서 다시 적지 않는다(CLAUDE.md).
 *
 * **DB 경계 매핑(`ArticleDocument`·`articlesCollection`)은 B-1에서 `@sentinel/core/db`로
 * 올라갔다.** specs/04 표에 아티클 오퍼레이션이 등재되며 소비자가 둘(worker 배치, api)이
 * 됐고 `api → worker`는 형제 간선이라 lint가 막기 때문이다. 여기서 re-export하지 않는다 —
 * 경유지라도 두 개의 출처처럼 보인다(T-037이 `parseApiKeys`에서 낸 같은 판단).
 *
 * 이 파일에 남은 것은 **야간 배치 고유한 것**뿐이다: "같은 소스 집합은 같은 문서"라는 멱등 키.
 */
import { createHash } from "node:crypto";

import type { ArticleKind } from "@sentinel/contracts";
import { ObjectId } from "mongodb";

/**
 * 아티클의 `_id`를 **소스 집합에서 유도한다.** T-029 Scope: "중복 방지: 동일 소스 집합 해시".
 *
 * ## 왜 보조 인덱스가 아니라 `_id`인가 (T-022가 연 길)
 * 중복 제거 키가 `_id`가 아니면, 배치가 두 번 겹쳐 돌 때 두 실행이 모두 "없다"고 판단해
 * 후보가 두 벌 생긴다. `_id`는 어느 컬렉션에나 이미 unique이므로 그 창을 원천적으로 닫는다.
 * 야간 배치는 재실행·중복 실행이 일상이라(운영자 수동 트리거, cron 중복) 이 성질이 필수다.
 *
 * ## 정렬이 계약의 일부다
 * 소스 id를 정렬하지 않으면 같은 집합이 조회 순서에 따라 다른 해시를 낸다 —
 * 그 순간 멱등성이 "대체로 성립"으로 격하되고, 깨지는 날은 인덱스 힌트가 바뀌는 날이다.
 */
export function articleId(kind: ArticleKind, sourceRecordIds: readonly string[]): ObjectId {
  const sorted = [...sourceRecordIds].sort();
  // 구분자로 NUL을 쓴다. id 사이 경계가 문자열 연결로 뭉개지는 것을 막는다.
  const digest = createHash("sha256")
    .update(["article", kind, ...sorted].join("\u0000"))
    .digest();
  return new ObjectId(digest.subarray(0, 12));
}

/**
 * 라벨을 URL 조각으로 낮춘다. 한글처럼 ASCII 밖 문자는 전부 떨어져 나가므로
 * **이 함수만으로 유일성을 보장하지 않는다** — 호출부가 항상 해시 접미사를 붙인다.
 */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** 슬러그 = `<유형>-<라벨>-<_id 앞 8자>`. 접미사가 유일성을, 라벨이 가독성을 맡는다. */
export function articleSlug(kind: ArticleKind, label: string, id: ObjectId): string {
  const label_ = slugifyLabel(label);
  const suffix = id.toHexString().slice(0, 8);
  return label_.length > 0 ? `${kind}-${label_}-${suffix}` : `${kind}-${suffix}`;
}
