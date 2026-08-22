/**
 * 도그푸딩 계측 (T-024 Scope 3).
 *
 * `eval/dogfood-log.jsonl`의 append-only 이벤트를 ISO 주 단위로 집계해
 * `eval/reports/dogfood-{week}.json`을 만든다.
 *
 * ## 왜 DB가 아니라 로컬 로그인가
 * `specs/00-product.md` 성공 지표는 "도그푸딩 실기록(4주) >= 30건, 적중 >= 5건"이다.
 * 기록 건수는 나중에 DB로 대조할 수 있지만 **검색은 그렇지 않다.**
 * 0건을 돌려준 검색은 서버에 아무 흔적도 남기지 않는데,
 * 우리가 알고 싶은 것이 정확히 그 미스율이다("프로토콜이 지켜지는가"보다
 * "지켜도 소용이 없는가"가 먼저 드러나야 한다).
 * 그래서 로그는 DB의 중복 사본이 아니라 **DB가 원리적으로 모르는 것**을 담는다.
 * record 이벤트는 recordId를 들고 있으므로 서버가 뜨면 대조 가능한 사본이 된다.
 *
 * ## 손상 입력은 조용히 넘기지 않는다
 * 로그는 사람과 에이전트가 손으로 덧붙이는 파일이라 깨진 줄이 생긴다.
 * 그 줄을 건너뛰면 리포트는 조용히 작아지고, 지표가 낮은 이유가
 * "안 했다"인지 "로그가 깨졌다"인지 영영 구분되지 않는다.
 * 그래서 **줄 번호를 달고 죽는다** — `eval/retrieval/report-io.ts`와 같은 규약이다.
 */

/** 이 이벤트 종류가 CLAUDE.md 도그푸딩 프로토콜의 세 동작에 1:1로 대응한다. */
export const DOGFOOD_EVENTS = ["search", "record", "hit"] as const;
export type DogfoodEventKind = (typeof DOGFOOD_EVENTS)[number];

export const RECORD_TYPES = ["incident", "divergence"] as const;
export type DogfoodRecordType = (typeof RECORD_TYPES)[number];

/** 레포 루트 기준 상대 경로. 문서가 이 상수를 인용하고 가드가 대조한다. */
export const DOGFOOD_LOG_PATH = "eval/dogfood-log.jsonl";
export const DOGFOOD_REPORT_DIR = "eval/reports";

/**
 * specs/00-product.md 성공 지표: "도그푸딩 실기록 (4주) >= 30건, 적중 >= 5건".
 * **이 숫자를 리포트를 통과시키려고 낮추지 않는다** — 기준선과 같은 규칙이다.
 */
export const TRAILING_WEEKS = 4;
export const TARGET_RECORDS_4W = 30;
export const TARGET_HITS_4W = 5;

/** `search` 이벤트: 디버깅 **전에** 부른 검색 1회. `results`는 돌아온 건수다. */
export interface DogfoodSearchEvent {
  readonly ts: string;
  readonly event: "search";
  readonly results: number;
  readonly taskId?: string;
  readonly query?: string;
}

/** `record` 이벤트: `record_knowledge` 1회. */
export interface DogfoodRecordEvent {
  readonly ts: string;
  readonly event: "record";
  readonly recordId: string;
  readonly type: DogfoodRecordType;
  readonly taskId?: string;
}

/**
 * `hit` 이벤트(적중): `give_feedback(helped: true)` 1회.
 *
 * "검색이 무언가를 돌려줬다"(=`search.results > 0`)와 **구분한다.**
 * 돌려준 것이 실제로 해결에 쓰였는지는 FR-07의 피드백만이 안다.
 * 성공 지표의 "적중"은 이쪽이다 — 30건 기록에 적중 5건이라는 목표 비율은
 * "결과가 나온 검색"이 아니라 "쓸모 있었던 결과"를 세는 척도에서만 말이 된다.
 */
export interface DogfoodHitEvent {
  readonly ts: string;
  readonly event: "hit";
  readonly recordId: string;
  readonly taskId?: string;
  readonly note?: string;
}

export type DogfoodEvent = DogfoodSearchEvent | DogfoodRecordEvent | DogfoodHitEvent;

/** 줄 번호를 들고 죽는 오류. 어느 줄이 깨졌는지 모르면 고칠 수 없다. */
export class DogfoodLogError extends Error {
  public readonly line: number;
  public constructor(line: number, message: string) {
    super(`${DOGFOOD_LOG_PATH}:${String(line)} — ${message}`);
    this.name = "DogfoodLogError";
    this.line = line;
  }
}

/**
 * 주 표기 오입력. `DogfoodLogError`와 나누는 이유는 **고치는 사람이 다르기** 때문이다 —
 * 이쪽은 호출자의 인자이고 저쪽은 로그 파일이다. CLI가 그 둘을 같은 종료 코드로 묶더라도
 * 메시지가 어느 쪽을 가리키는지는 타입이 정한다.
 */
export class DogfoodWeekError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DogfoodWeekError";
  }
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;

/** 월=0 … 일=6. ISO 8601은 월요일을 주의 시작으로 본다. */
function isoDayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** 그 날짜가 속한 ISO 주의 목요일. ISO 주의 연도는 목요일이 정한다. */
function isoThursdayOf(date: Date): Date {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - isoDayIndex(t) + 3);
  return t;
}

/**
 * ISO 8601 주 표기(`2026-W34`).
 *
 * 달력 연도를 쓰지 않는 이유는 연말·연초가 갈라지기 때문이다.
 * 2024-12-30(월)은 2025-W01이고 2027-01-03(일)은 2026-W53이다 —
 * 달력 연도로 묶으면 그 주의 기록이 두 파일로 쪼개지거나 사라진다.
 */
export function isoWeekOf(date: Date): string {
  const thursday = isoThursdayOf(date);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = isoThursdayOf(new Date(Date.UTC(isoYear, 0, 4)));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / WEEK_MS);
  return `${String(isoYear)}-W${String(week).padStart(2, "0")}`;
}

/** ISO 주의 월요일 00:00Z. */
export function isoWeekStart(week: string): Date {
  const match = ISO_WEEK_RE.exec(week);
  if (match === null) throw new DogfoodWeekError(`ISO 주 표기가 아니다: ${week} (예: 2026-W34)`);
  const isoYear = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) {
    throw new DogfoodWeekError(`주 번호가 1~53 밖이다: ${week}`);
  }
  const firstThursday = isoThursdayOf(new Date(Date.UTC(isoYear, 0, 4)));
  const monday = new Date(firstThursday.getTime() - 3 * DAY_MS + (weekNumber - 1) * WEEK_MS);
  // 53주가 없는 해에 `2026-W53`을 주면 다음 해로 넘어간다. 조용히 옆 주를 집계하지 않는다.
  if (isoWeekOf(monday) !== week) {
    throw new DogfoodWeekError(`${String(isoYear)}년에 없는 주다: ${week}`);
  }
  return monday;
}

/** `2026-08-17` 형태. 리포트에 주의 시작·끝을 사람이 읽을 수 있게 싣는다. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 최근 `count`주(이번 주 포함)를 과거→현재 순으로. */
export function trailingWeeks(week: string, count: number): string[] {
  const monday = isoWeekStart(week);
  const weeks: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    weeks.push(isoWeekOf(new Date(monday.getTime() - offset * WEEK_MS)));
  }
  return weeks;
}

function fail(line: number, message: string): never {
  throw new DogfoodLogError(line, message);
}

function requireString(raw: Record<string, unknown>, key: string, line: number): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(line, `\`${key}\`가 비어 있지 않은 문자열이어야 한다.`);
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  line: number,
): string | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined;
  return requireString(raw, key, line);
}

/**
 * `exactOptionalPropertyTypes`가 켜져 있어 `{ taskId: undefined }`를 얹을 수 없다.
 * 조건부 스프레드로 **키 자체를 만들지 않는다** — 리포트 JSON에도 빈 키가 안 남는다.
 */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function parseEvent(raw: Record<string, unknown>, line: number): DogfoodEvent {
  const ts = requireString(raw, "ts", line);
  if (Number.isNaN(Date.parse(ts))) fail(line, `\`ts\`가 파싱되지 않는다: ${ts}`);

  const kind = requireString(raw, "event", line);
  if (!(DOGFOOD_EVENTS as readonly string[]).includes(kind)) {
    fail(line, `\`event\`는 ${DOGFOOD_EVENTS.join("|")} 중 하나여야 한다: ${kind}`);
  }
  const taskId = optionalString(raw, "taskId", line);

  if (kind === "search") {
    const results = raw["results"];
    if (typeof results !== "number" || !Number.isInteger(results) || results < 0) {
      // 빠뜨리면 "0건이었다"와 "안 적었다"가 구분되지 않는다 — 미스율이 통째로 거짓이 된다.
      fail(line, "`search`에는 0 이상의 정수 `results`(돌아온 건수)가 필요하다.");
    }
    return {
      ts,
      event: "search",
      results,
      ...optional("taskId", taskId),
      ...optional("query", optionalString(raw, "query", line)),
    };
  }

  const recordId = requireString(raw, "recordId", line);
  if (kind === "hit") {
    return {
      ts,
      event: "hit",
      recordId,
      ...optional("taskId", taskId),
      ...optional("note", optionalString(raw, "note", line)),
    };
  }

  const type = requireString(raw, "type", line);
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    fail(line, `\`type\`은 ${RECORD_TYPES.join("|")} 중 하나여야 한다: ${type}`);
  }
  return {
    ts,
    event: "record",
    recordId,
    type: type as DogfoodRecordType,
    ...optional("taskId", taskId),
  };
}

/**
 * JSONL을 이벤트 배열로. 빈 줄만 건너뛰고 나머지는 전부 판정한다.
 * 깨진 줄 하나가 리포트 전체를 죽인다 — 의도한 동작이다(파일 상단 참조).
 */
export function parseDogfoodLog(raw: string): DogfoodEvent[] {
  const events: DogfoodEvent[] = [];
  const lines = raw.split("\n");
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    if (text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      fail(line, `JSON이 아니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(line, "한 줄은 객체 하나여야 한다.");
    }
    events.push(parseEvent(parsed as Record<string, unknown>, line));
  }
  return events;
}

export interface DogfoodReport {
  readonly week: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly generatedAt: string;
  readonly source: string;
  readonly sourceEvents: number;
  readonly records: {
    readonly total: number;
    readonly byType: Record<DogfoodRecordType, number>;
  };
  readonly searches: {
    readonly total: number;
    readonly withResults: number;
    readonly zeroResult: number;
    /** withResults / total. total이 0이면 null — 0으로 적으면 "안 했다"가 "다 실패했다"로 읽힌다. */
    readonly resultRate: number | null;
  };
  /** 적중 = `give_feedback(helped: true)`. 성공 지표의 "적중"이 이것이다. */
  readonly hits: {
    readonly total: number;
    readonly recordIds: string[];
  };
  readonly trailing4Weeks: {
    readonly weeks: string[];
    readonly records: number;
    readonly hits: number;
    readonly target: { readonly records: number; readonly hits: number };
    readonly meetsTarget: boolean;
  };
}

function inWeek(event: DogfoodEvent, week: string): boolean {
  return isoWeekOf(new Date(event.ts)) === week;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface BuildOptions {
  readonly week: string;
  readonly generatedAt: Date;
}

export function buildDogfoodReport(
  events: readonly DogfoodEvent[],
  { week, generatedAt }: BuildOptions,
): DogfoodReport {
  const monday = isoWeekStart(week);
  const weeks = trailingWeeks(week, TRAILING_WEEKS);
  const weekSet = new Set(weeks);

  const ofWeek = events.filter((event) => inWeek(event, week));
  const records = ofWeek.filter((event): event is DogfoodRecordEvent => event.event === "record");
  const searches = ofWeek.filter((event): event is DogfoodSearchEvent => event.event === "search");
  const hits = ofWeek.filter((event): event is DogfoodHitEvent => event.event === "hit");

  const withResults = searches.filter((event) => event.results > 0).length;
  const trailing = events.filter((event) => weekSet.has(isoWeekOf(new Date(event.ts))));
  const trailingRecords = trailing.filter((event) => event.event === "record").length;
  const trailingHits = trailing.filter((event) => event.event === "hit").length;

  return {
    week,
    weekStart: toIsoDate(monday),
    weekEnd: toIsoDate(new Date(monday.getTime() + 6 * DAY_MS)),
    generatedAt: generatedAt.toISOString(),
    source: DOGFOOD_LOG_PATH,
    sourceEvents: events.length,
    records: {
      total: records.length,
      byType: {
        incident: records.filter((event) => event.type === "incident").length,
        divergence: records.filter((event) => event.type === "divergence").length,
      },
    },
    searches: {
      total: searches.length,
      withResults,
      zeroResult: searches.length - withResults,
      resultRate: searches.length === 0 ? null : round4(withResults / searches.length),
    },
    hits: {
      total: hits.length,
      recordIds: [...new Set(hits.map((event) => event.recordId))].sort(),
    },
    trailing4Weeks: {
      weeks,
      records: trailingRecords,
      hits: trailingHits,
      target: { records: TARGET_RECORDS_4W, hits: TARGET_HITS_4W },
      meetsTarget: trailingRecords >= TARGET_RECORDS_4W && trailingHits >= TARGET_HITS_4W,
    },
  };
}

export function dogfoodReportFileName(week: string): string {
  return `dogfood-${week}.json`;
}

/** 사람이 읽는 한 줄 요약. stdout(JSON)과 섞이지 않게 호출자가 stderr로 낸다. */
export function summarizeDogfoodReport(report: DogfoodReport): string {
  const { records, searches, hits, trailing4Weeks: trailing } = report;
  const rate = searches.resultRate === null ? "-" : `${String(round4(searches.resultRate * 100))}%`;
  return (
    `[dogfood] ${report.week} (${report.weekStart}~${report.weekEnd}) ` +
    `기록 ${String(records.total)}건(incident ${String(records.byType.incident)}/` +
    `divergence ${String(records.byType.divergence)}) · ` +
    `검색 ${String(searches.total)}회(결과 있음 ${String(searches.withResults)}, 비율 ${rate}) · ` +
    `적중 ${String(hits.total)}건\n` +
    `[dogfood] 4주 누적: 기록 ${String(trailing.records)}/${String(trailing.target.records)} · ` +
    `적중 ${String(trailing.hits)}/${String(trailing.target.hits)} · ` +
    `목표 ${trailing.meetsTarget ? "충족" : "미충족"} (specs/00 성공 지표)`
  );
}
