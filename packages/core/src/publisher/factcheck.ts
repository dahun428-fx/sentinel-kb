/**
 * 팩트 대조 — specs/08-publishing.md §3의 마지막 문장이 코드가 되는 자리.
 *
 * > "본문에 등장하는 모든 수치는 facts에 존재해야 한다 — **인용 검증과 같은 방식으로
 * >  후처리 대조**하며, facts에 없는 숫자는 반려 사유다."
 *
 * ## 무엇을 T-020에서 그대로 가져왔는가
 *
 * T-020의 인용 검증은 "인용 형식이 맞는가"가 아니라 **"그 ID가 실제 컨텍스트에 있었는가"**를
 * 핵심으로 삼았다. 형식만 보면 모델이 그럴듯한 ID를 지어내도 통과하기 때문이다.
 * 여기서도 같다: "숫자처럼 생겼는가"가 아니라 **"그 숫자가 팩트 팩에 실재하는가"**를 본다.
 * 그래서 허용 집합은 팩트 팩에서 **기계적으로** 유도하고(`buildAllowedFacts`), 본문에서
 * 뽑은 토큰이 그 집합에 없으면 위반이다. 화이트리스트이지 블랙리스트가 아니다.
 *
 * ## 네 축 — 수치·날짜·이름·원문
 *
 * 1. **코드/로그 블록의 각 줄**은 어떤 팩트 문자열의 부분열이어야 한다. §0-2가 요구한
 *    "에러 원문 인용"을 모델이 **지어내는** 경로가 정확히 여기다. 블록 하나는 린터가
 *    강제하므로(`missing-code-block`), 이 검사가 없으면 밀도 규칙이 곧 날조 유인이 된다.
 * 2. **백틱·따옴표 구간**도 같은 규칙이다. 이 레포의 문체에서 원문(명령어·에러·경로·식별자)은
 *    거기 들어간다. 지어낸 명령어가 발행물에 실리는 것을 막는 자리다.
 * 3. **날짜**는 팩트 팩의 기간·타임라인에 실재하는 날짜여야 한다. 숫자런으로만 검사하면
 *    `2026-05-11`의 `11`이 무관한 카운트 11에 걸려 통과한다 — 날짜는 날짜로 대조한다.
 * 4. **나머지 숫자런**은 팩트 팩에서 유도된 수치 집합에 있어야 한다.
 *
 * ## 유도 계산은 위반이다 — 그리고 그게 맞다
 *
 * 팩트 팩에 `records: 8`과 `incidents: 5`가 있어도 본문의 "62%"는 위반이다. §0-1이
 * **"통계·타임라인·차트 데이터는 결정론적 코드가 DB에서 계산한다"**고 못박았기 때문이다.
 * 모델이 산술을 하기 시작하면 그 산술이 맞는지 검증할 방법이 없고, 검증할 수 없는 수치가
 * 발행물에 실리는 것이 정확히 §3이 막으려던 것이다. 필요한 비율은 팩트 추출기가 내야 한다.
 *
 * ## 이 검사가 **못 잡는 것** (숨기지 않는다)
 *
 * 수치·날짜·이름·원문은 잡지만 **인과 주장은 못 잡는다.** "pnpm 10이 postinstall을 차단해서
 * 그렇다"가 참인지 거짓인지 이 코드는 모른다. 그 축의 방어는 검사가 아니라 입력이다 —
 * 모델에게 레코드의 `rootCause` 산문을 실제로 주는 것(`narrative.ts` 판단 1),
 * 그리고 §0-5의 사람 편집이다.
 */
import type { ArticleFacts, FactEvidence } from "../facts/types.js";

/** 위반의 종류. 축마다 고쳐야 할 것이 달라서 한 종류로 접지 않는다. */
export const FACT_VIOLATION_KINDS = ["code-line", "quote", "date", "record-id", "number"] as const;
export type FactViolationKind = (typeof FACT_VIOLATION_KINDS)[number];

export interface FactViolation {
  readonly kind: FactViolationKind;
  /** 팩트 팩에 없는 그 값. 재작성·반려 사유에 그대로 실린다. */
  readonly value: string;
}

export interface FactCheckCounts {
  readonly codeLines: number;
  readonly quotes: number;
  readonly dates: number;
  readonly recordIds: number;
  readonly numbers: number;
}

export interface FactCheckReport {
  readonly factCheckVersion: 1;
  readonly passed: boolean;
  /** 각 축에서 **검사한** 토큰 수. 0이면 "위반이 없었다"가 아니라 "검사할 게 없었다"이다. */
  readonly checked: FactCheckCounts;
  readonly violations: readonly FactViolation[];
}

/** 팩트 팩에서 유도한 허용 집합. 순수 데이터라 테스트가 직접 들여다볼 수 있다. */
export interface AllowedFacts {
  /** 원문 그대로 실려도 되는 문자열 전부(스니펫·태그·이름·ID·ISO 시각). */
  readonly strings: readonly string[];
  /** 정규화된 수치 토큰. */
  readonly numbers: ReadonlySet<string>;
  /** `YYYY-MM-DD`. */
  readonly dates: ReadonlySet<string>;
  readonly recordIds: ReadonlySet<string>;
}

const FENCE_RE = /^\s*```/;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const DOUBLE_QUOTED_RE = /"([^"\n]+)"|“([^”\n]+)”/g;
const ORDERED_MARKER_RE = /^[ \t]*\d+\.[ \t]/gm;
const DIGIT_RUN_RE = /\d+/g;
const OBJECT_ID_RE = /\b[0-9a-f]{24}\b/g;
/** 셸 전사(轉寫)의 프롬프트 표시. 인용 대조 전에 걷어낸다. */
const SHELL_PROMPT_RE = /^[$>#]\s+/;

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DOTTED_DATE_RE = /\b(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\b/g;
const KOREAN_DATE_RE = /\b(\d{4})년\s?(\d{1,2})월\s?(\d{1,2})일/g;
/** 연도 없는 날짜. 팩트 팩의 어떤 날짜와 월·일이 같으면 통과시킨다. */
const KOREAN_MONTH_DAY_RE = /(?<!\d)(\d{1,2})월\s?(\d{1,2})일/g;

/**
 * 팩트 팩 → 허용 집합. **팩트 팩 밖의 어떤 것도 여기 들어오지 않는다.**
 * 그래서 이 함수는 "무엇이 발행물에 실려도 되는가"의 유일한 정의가 된다.
 */
export function buildAllowedFacts(facts: ArticleFacts): AllowedFacts {
  const strings = new Set<string>();
  const numbers = new Set<string>();
  const dates = new Set<string>();

  const addString = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) strings.add(trimmed);
  };
  const addNumber = (value: number | null | undefined): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const text = String(value);
    numbers.add(normalizeNumber(text));
    for (const run of text.matchAll(DIGIT_RUN_RE)) numbers.add(normalizeNumber(run[0]));
  };
  const addTimestamp = (iso: string): void => {
    addString(iso);
    const day = iso.slice(0, 10);
    dates.add(day);
    for (const run of day.matchAll(DIGIT_RUN_RE)) numbers.add(normalizeNumber(run[0]));
  };

  for (const id of facts.sourceRecordIds) addString(id);

  addNumber(facts.counts.records);
  addNumber(facts.counts.incidents);
  addNumber(facts.counts.divergences);
  addNumber(facts.factsVersion);

  addTimestamp(facts.period.firstAt);
  addTimestamp(facts.period.lastAt);
  addNumber(facts.period.spanDays);

  for (const group of [
    facts.distributions.tags,
    facts.distributions.severity,
    facts.distributions.project,
  ]) {
    for (const entry of group) {
      addString(entry.key);
      addNumber(entry.count);
    }
  }
  for (const tag of facts.commonTags) addString(tag);

  for (const entry of facts.timeline) {
    addTimestamp(entry.at);
    addString(entry.recordId);
    addString(entry.type);
    addString(entry.severity);
  }

  addNumber(facts.recurrence.occurrences);
  addNumber(facts.recurrence.spanDays);
  addNumber(facts.recurrence.meanIntervalDays);
  addNumber(facts.recurrence.maxIntervalDays);
  addNumber(facts.recurrence.minIntervalDays);
  for (const interval of facts.recurrence.intervalsDays) addNumber(interval);
  for (const link of facts.recurrence.links) {
    addString(link.recordId);
    addString(link.targetRecordId);
    addString(link.type);
  }

  if (facts.divergence !== undefined) {
    addNumber(facts.divergence.count);
    for (const group of [
      facts.divergence.byModel,
      facts.divergence.byTool,
      facts.divergence.byFramework,
      facts.divergence.correctionCategories,
    ]) {
      for (const entry of group) {
        addString(entry.key);
        addNumber(entry.count);
      }
    }
    for (const cell of facts.divergence.modelByCorrection) {
      addString(cell.row);
      addString(cell.column);
      addNumber(cell.count);
    }
    for (const correction of facts.divergence.corrections) {
      addString(correction.recordId);
      addString(correction.category);
      addString(correction.marker);
    }
  }

  for (const evidence of [...facts.citations, ...facts.signals]) {
    addEvidence(evidence, addString, addNumber);
  }

  addNumber(facts.density.records);
  addNumber(facts.density.citations);
  addNumber(facts.density.signals);
  addNumber(facts.density.timelineEntries);
  addNumber(facts.density.recordsWithoutEvidence);

  for (const exclusion of facts.excluded) {
    addString(exclusion.recordId);
    addString(exclusion.reason);
  }

  // 스니펫 안에 박힌 숫자는 그 스니펫과 함께 실린다 — `27017`·`5000`이 그렇다.
  for (const value of strings) {
    for (const run of value.matchAll(DIGIT_RUN_RE)) numbers.add(normalizeNumber(run[0]));
  }

  return {
    strings: [...strings],
    numbers,
    dates,
    recordIds: new Set(facts.sourceRecordIds),
  };
}

function addEvidence(
  evidence: FactEvidence,
  addString: (value: string | undefined) => void,
  addNumber: (value: number) => void,
): void {
  addString(evidence.text);
  addString(evidence.kind);
  addNumber(evidence.recordCount);
  for (const id of evidence.recordIds) addString(id);
  for (const section of evidence.sections) addString(section);
}

/**
 * 본문 × 팩트 팩. **본문을 고치지 않는다** — 판정만 하고 반려는 호출자가 한다
 * (`draft.ts`). 순수 함수이므로 같은 초안이면 같은 판정이 나온다.
 */
export function crossCheckFacts(body: string, facts: ArticleFacts): FactCheckReport {
  const allowed = buildAllowedFacts(facts);
  const violations: FactViolation[] = [];
  const checked = { codeLines: 0, quotes: 0, dates: 0, recordIds: 0, numbers: 0 };

  const { fences, prose } = splitFences(body);

  for (const fence of fences) {
    for (const rawLine of fence.split("\n")) {
      const line = rawLine.trim().replace(SHELL_PROMPT_RE, "").trim();
      if (line.length === 0) continue;
      checked.codeLines += 1;
      if (!isGroundedString(line, allowed)) {
        violations.push({ kind: "code-line", value: line });
      }
    }
  }

  let remaining = prose;

  for (const pattern of [INLINE_CODE_RE, DOUBLE_QUOTED_RE]) {
    for (const match of remaining.matchAll(pattern)) {
      const inner = (match[1] ?? match[2] ?? "").trim();
      if (inner.length === 0) continue;
      checked.quotes += 1;
      if (!isGroundedString(inner, allowed)) {
        violations.push({ kind: "quote", value: inner });
      }
    }
    remaining = remaining.replace(pattern, " ");
  }

  for (const { pattern, resolve } of DATE_PATTERNS) {
    for (const match of remaining.matchAll(pattern)) {
      checked.dates += 1;
      if (!resolve(match, allowed)) {
        violations.push({ kind: "date", value: match[0] });
      }
    }
    remaining = remaining.replace(pattern, " ");
  }

  for (const match of remaining.matchAll(OBJECT_ID_RE)) {
    checked.recordIds += 1;
    if (!allowed.recordIds.has(match[0])) {
      violations.push({ kind: "record-id", value: match[0] });
    }
  }
  remaining = remaining.replace(OBJECT_ID_RE, " ");

  // 순서 매김(`1. `)은 구조 표시이지 주장이 아니다.
  remaining = remaining.replace(ORDERED_MARKER_RE, " ");

  for (const match of remaining.matchAll(DIGIT_RUN_RE)) {
    checked.numbers += 1;
    if (!allowed.numbers.has(normalizeNumber(match[0]))) {
      violations.push({ kind: "number", value: match[0] });
    }
  }

  return {
    factCheckVersion: 1,
    passed: violations.length === 0,
    checked,
    violations: dedupe(violations),
  };
}

/** `03` → `3`, `000` → `0`. 자릿수 표기 차이로 실재하는 값이 위반이 되지 않게 한다. */
function normalizeNumber(text: string): string {
  const stripped = text.replace(/^0+/, "");
  return stripped.length === 0 ? "0" : stripped;
}

/** 팩트 문자열 중 하나에 **포함**되면 근거가 있다. 부분 인용을 막을 이유는 없다. */
function isGroundedString(value: string, allowed: AllowedFacts): boolean {
  return allowed.strings.some((candidate) => candidate.includes(value));
}

interface DatePattern {
  readonly pattern: RegExp;
  readonly resolve: (match: RegExpMatchArray, allowed: AllowedFacts) => boolean;
}

const DATE_PATTERNS: readonly DatePattern[] = [
  { pattern: ISO_DATE_RE, resolve: (match, allowed) => hasFullDate(match, allowed) },
  { pattern: DOTTED_DATE_RE, resolve: (match, allowed) => hasFullDate(match, allowed) },
  { pattern: KOREAN_DATE_RE, resolve: (match, allowed) => hasFullDate(match, allowed) },
  {
    pattern: KOREAN_MONTH_DAY_RE,
    resolve: (match, allowed) => {
      const monthDay = `${pad(match[1])}-${pad(match[2])}`;
      return [...allowed.dates].some((date) => date.endsWith(monthDay));
    },
  },
];

function hasFullDate(match: RegExpMatchArray, allowed: AllowedFacts): boolean {
  return allowed.dates.has(`${match[1] ?? ""}-${pad(match[2])}-${pad(match[3])}`);
}

function pad(value: string | undefined): string {
  return (value ?? "").padStart(2, "0");
}

function splitFences(body: string): { fences: string[]; prose: string } {
  const fences: string[] = [];
  const proseLines: string[] = [];
  let inFence = false;
  let buffer: string[] = [];
  for (const line of body.split("\n")) {
    if (FENCE_RE.test(line)) {
      if (inFence) {
        fences.push(buffer.join("\n"));
        buffer = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) buffer.push(line);
    else proseLines.push(line);
  }
  if (inFence) fences.push(buffer.join("\n"));
  return { fences, prose: proseLines.join("\n") };
}

/** 같은 값이 여러 번 나와도 위반은 한 번만 센다 — 재작성 지시문이 같은 말을 반복하지 않게. */
function dedupe(violations: readonly FactViolation[]): FactViolation[] {
  const seen = new Set<string>();
  const out: FactViolation[] = [];
  for (const violation of violations) {
    const key = `${violation.kind} ${violation.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}
