/**
 * 레코드 필드의 종류별 소속. 출처: specs/02-data-model.md records, specs/04-api.md.
 *
 * ## 왜 이 파일이 필요한가 (T-002 F-2)
 * `PatchRecordInput`은 **평면 partial**이다. 판별 유니온이 아니므로
 * `PATCH /v1/records/{incident-id}` 바디에 `{"expected": "..."}`를 넣으면 **계약 레벨에서 통과한다.**
 * 그대로 저장하면 `type: "incident"`인데 `expected`를 가진 도큐먼트가 만들어지고,
 * 그 도큐먼트는 **`RecordSchema`로 다시 읽히지 않는다** — `IncidentRecord`에 `expected`가 없기 때문이다.
 * 워커의 `loadRecord`가 그걸 `RECORD_INVALID` 영구 실패로 떨어뜨리고, 레코드는 영원히 임베딩되지 않는다.
 *
 * contracts를 판별 유니온 partial로 바꾸는 것이 근본 해결이지만 그건 계약 재개방(G3)이다.
 * T-007은 **서버에서** 막는다: 저장 전에 기존 레코드의 `type`을 읽어 그 종류의 필드만 허용한다.
 */
import type { RecordType } from "@sentinel/contracts";

/** 종류와 무관하게 PATCH할 수 있는 필드. `type`·`project`는 여기 없다(서버 소유). */
export const COMMON_PATCH_FIELDS = ["title", "severity", "tags", "status", "relations"] as const;

/** incident 전용. specs/02 records의 `// incident` 블록 그대로다. */
export const INCIDENT_FIELDS = ["symptom", "rootCause", "resolution", "prevention"] as const;

/** divergence 전용. `context`는 본문 섹션이 아니지만 divergence에만 존재한다. */
export const DIVERGENCE_FIELDS = ["expected", "actual", "context", "correction"] as const;

/**
 * 청킹 대상 **본문 섹션**. specs/02 `chunks.section` 열거와 같은 집합이다.
 * PATCH가 이 중 하나를 건드리면 재임베딩 job이 필요하다(specs/04).
 * `context`는 여기 없다 — 청크가 되지 않으므로 바꿔도 벡터가 낡지 않는다.
 */
export const BODY_SECTION_FIELDS = [
  "symptom",
  "rootCause",
  "resolution",
  "prevention",
  "expected",
  "actual",
  "correction",
] as const;

export type BodySectionField = (typeof BODY_SECTION_FIELDS)[number];

/** 새니타이즈 대상이 되는 자유 텍스트 필드. `title` + 본문 섹션 + `context`의 값들. */
export const FREE_TEXT_FIELDS = ["title", ...BODY_SECTION_FIELDS] as const;

/** `context` 하위 키. `DivergenceContext`(contracts)의 필드 그대로다. */
export const CONTEXT_KEYS = ["model", "tool", "framework"] as const;

export type ContextKey = (typeof CONTEXT_KEYS)[number];

/** 해당 종류의 레코드가 PATCH로 받을 수 있는 필드 전부. */
export function allowedPatchFields(type: RecordType): ReadonlySet<string> {
  return new Set<string>([
    ...COMMON_PATCH_FIELDS,
    ...(type === "incident" ? INCIDENT_FIELDS : DIVERGENCE_FIELDS),
  ]);
}

export function isBodySectionField(name: string): name is BodySectionField {
  return (BODY_SECTION_FIELDS as readonly string[]).includes(name);
}

/**
 * `summary`를 뽑아 오는 섹션. 근거는 `summary.ts`의 파일 주석에 있다 —
 * 요약의 목적이 "이게 내 문제인가"의 판별이고, 두 필드 모두 해당 종류의 **필수** 필드다.
 */
export function summarySourceField(type: RecordType): "symptom" | "expected" {
  return type === "incident" ? "symptom" : "expected";
}

/**
 * PATCH가 `$set`으로 쓸 수 있는 필드. **`embeddingVersion`이 없는 것이 요점이다.**
 *
 * specs/02: 이 필드는 "마지막으로 온전히 임베딩된 세대" 워터마크이고 올리는 주체는
 * 인제스트 워커 단독이다. T-007은 생성 시 `0`으로 초기화하는 것까지만 한다.
 * 도큐먼트를 통째로 `$set`하거나 재검증 후 전체 치환하면 워터마크가 0으로 되돌아가
 * **이미 임베딩된 record가 미임베딩으로 오인된다.**
 * `PatchRecordInput`의 `.strict()`는 클라이언트 주입만 막을 뿐 서버 내부의 전체 치환은 못 막는다 —
 * 그래서 여기 화이트리스트를 두고 `$set` 조립 결과를 대조한다.
 */
export const PATCHABLE_STORED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PATCH_FIELDS,
  ...INCIDENT_FIELDS,
  ...DIVERGENCE_FIELDS,
  // 서버가 파생하는 필드. 클라이언트는 못 보내지만 서버는 갱신한다.
  "summary",
  "sanitizeFlags",
  "updatedAt",
]);
