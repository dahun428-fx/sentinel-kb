/**
 * core-api의 JSON 응답을 contracts 스키마로 되돌리는 어댑터.
 *
 * **타입을 재정의하지 않는다**(CLAUDE.md: "API 계약은 `packages/contracts`의 Zod 스키마가
 * 단일 소스"). 여기 있는 것은 스키마가 아니라 **전선 표현과 도메인 표현의 차이**를 메우는
 * 코드뿐이다 — 구체적으로는 날짜 하나다: `RecordSchema.createdAt`은 `z.date()`인데
 * JSON에는 Date가 없어서 ISO 문자열로 온다. 스키마를 느슨하게 고치는 대신 값을 되살린다.
 */
import { RecordSchema, SearchResponse, type SearchHit } from "@sentinel/contracts";

export function parseSearchHits(raw: unknown): SearchHit[] {
  return SearchResponse.parse(raw).results;
}

const DATE_KEYS = ["createdAt", "updatedAt"] as const;

/** `{createdAt,updatedAt}`만 ISO 문자열 → Date로 되살린 얕은 복사본. */
function reviveDates(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const source = raw as Record<string, unknown>;
  const revived: Record<string, unknown> = { ...source };
  for (const key of DATE_KEYS) {
    const value = source[key];
    if (typeof value === "string") revived[key] = new Date(value);
  }
  return revived;
}

/** `GET /v1/records/:id` · `POST /v1/records` 응답을 contracts의 `RecordSchema`로 파싱한다. */
export function parseRecord(raw: unknown): RecordSchema {
  return RecordSchema.parse(reviveDates(raw));
}

/**
 * `POST /v1/records`가 새니타이즈 결과를 붙여 보내는 `warning`.
 *
 * **이 형상은 contracts에 없다** — specs/04 표에 `POST /v1/records`의 응답 스키마가
 * 없어서 `packages/api`가 `{message, masked[], injectionRules[]}`를 직접 얹고 있다.
 * contracts를 고치는 것은 G3(인간 승인)라 여기서는 **읽기만** 하고, 없거나 형상이 달라도
 * 죽지 않게 방어적으로 꺼낸다. specs/07 §3의 "무엇이 마스킹됐는지 알려준다"가
 * 이 필드에 의존하므로 인계 사항으로 남긴다(Findings).
 */
export interface SanitizeWarningWire {
  readonly message: string;
  readonly masked: string[];
  readonly injectionRules: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readSanitizeWarning(raw: unknown): SanitizeWarningWire | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const warning: unknown = (raw as { warning?: unknown }).warning;
  if (typeof warning !== "object" || warning === null) return undefined;
  const message: unknown = (warning as { message?: unknown }).message;
  if (typeof message !== "string" || message.length === 0) return undefined;
  return {
    message,
    masked: stringArray((warning as { masked?: unknown }).masked),
    injectionRules: stringArray((warning as { injectionRules?: unknown }).injectionRules),
  };
}
