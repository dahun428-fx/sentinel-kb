/**
 * JSON 응답의 날짜 문자열을 `Date`로 되살린다.
 *
 * 왜 필요한가: `packages/contracts`의 `RecordSchema`·`RecordSummary`는 `createdAt`·
 * `updatedAt`을 `z.date()`로 정의한다(contracts가 단일 소스이므로 웹에서 재정의하지 않는다).
 * 그런데 HTTP를 건너오면 그 값은 ISO 문자열이라 그대로는 파싱에 실패한다.
 * 그래서 **스키마를 고치는 대신** 파싱 직전에 값을 되살린다 — 계약은 그대로 두고
 * 전송 포맷만 되돌리는 것이 옳은 층위다.
 */

/** `Date`로 되살릴 키. contracts에서 `z.date()`인 필드만 넣는다. */
const DATE_KEYS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);

/** `2026-08-21T00:00:00.000Z` 형태만 되살린다 — 임의 문자열을 날짜로 오해하지 않기 위해서다. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 객체 트리를 순회하며 `DATE_KEYS`에 해당하는 ISO 문자열을 `Date`로 바꾼 새 값을 돌려준다.
 * 입력은 변형하지 않는다.
 */
export function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const revived: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DATE_KEYS.has(key) && typeof item === "string" && ISO_DATE.test(item)) {
      const parsed = new Date(item);
      revived[key] = Number.isNaN(parsed.getTime()) ? item : parsed;
      continue;
    }
    revived[key] = reviveDates(item);
  }
  return revived;
}
