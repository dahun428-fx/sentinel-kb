/**
 * 서사 재료 — **레코드 본문을 초안 프롬프트에 넣는 유일한 통로.**
 * 출처: specs/08-publishing.md §0-1·§4·§7, T-030 Findings F-1.
 *
 * ## 이 파일이 왜 존재하는가 — T-030 F-1에 대한 답
 *
 * T-030은 팩트 팩에서 **자유 서술을 통째로 뺐다.** 이유가 둘이었고 둘 다 옳다:
 * 산문에서 "요지"를 결정론으로 뽑을 수 없다는 것, 그리고 T-040이 못 닫은 미탐 축(일본어
 * 인젝션)이 발행물로 나가는 경로를 **형상 규칙으로 없앴다**는 것. 그리고 F-1은 경고를 남겼다:
 * "T-031이 서사를 쓰려면 레코드 본문을 따로 받아야 하고, **그 경로에는 이 방어가 없다.**"
 *
 * ### 판단 1: 팩트 팩만으로는 글이 되지 않는다
 *
 * 팩트 팩에 있는 것은 (a) 이산 필드값, (b) 그 산술, (c) ASCII 스니펫이다. 그것으로 쓸 수
 * 있는 것은 **"무엇이 있었는가"**뿐이다. 케이스 스터디가 요구하는 **"왜 그렇게 됐는가"**는
 * 팩트 팩 어디에도 없다 — `rootCause`는 산문이고 T-030이 뺐다. 예를 들어 팩트 팩은
 * `tags=[pnpm, pnpm-10, esbuild, postinstall]`과 에러 원문
 * `The package "@esbuild/darwin-arm64" could not be found`와 명령어 `pnpm approve-builds`를
 * 준다. 여기서 "pnpm 10이 postinstall을 기본 차단한다"는 인과는 **모델이 지어내야만** 나온다.
 *
 * 그리고 그 날조는 팩트 대조(`factcheck.ts`)로 잡히지 않는다. 팩트 대조는 수치·날짜·이름을
 * 보지 **인과 주장을 보지 않는다.** 즉 팩트 팩만 주는 설계는 "환각을 막는 설계"가 아니라
 * **환각을 검증 불가능한 자리로 옮기는 설계**다. 그래서 산문을 넣는다.
 *
 * ### 판단 2: 넣되, T-030이 세운 방어를 최대한 되가져온다
 *
 * 다섯 겹이고, 앞의 셋은 **기존 방어의 재사용**이지 새 발명이 아니다.
 *
 * 1. **`facts.sourceRecordIds` 소속만.** 팩트 팩에 들어간 레코드가 아니면 산문도 없다.
 *    `screenMaterial`(T-030)이 이미 `injection-suspect` 플래그 제외 + 발행 직전
 *    `detectInjection` 재판정을 했고, 그 판정을 **여기서 다시 흉내 내지 않고 결과를 신뢰한다.**
 *    T-018 `buildGenerationContext`가 `injection-suspect` 청크를 컨텍스트에서 빼는 것과 같은
 *    계열이며, 호출자가 임의의 레코드 배열을 넘겨도 팩트 팩에 없는 것은 산문이 되지 못한다.
 * 2. **`sanitizeFlags`가 비어 있어야 한다** (`isQuotable`, §7). 마스킹 라벨 주변 산문이
 *    모델을 거쳐 발행물에 재구성되는 것은 "원문 인용 금지"의 우회다.
 * 3. **`detectInjection` 재판정** (T-040 규칙). 1이 이미 했지만 여기서도 한다 — 호출자가
 *    팩트 팩과 다른 레코드 배열을 짝지어 넘기는 사고를 이 한 줄이 막는다.
 * 4. **스크립트 허용목록** — 이것이 T-030의 형상 방어를 산문에 되가져온 자리다. 아래 참조.
 * 5. **시크릿 형상 차단** — `containsSecretShape`(T-030 F-4) + `://` 형상. 아래 참조.
 *
 * ### 판단 3: 스크립트 허용목록이 미탐 축을 다시 닫는다 (완전히는 아니다)
 *
 * T-030의 `isMachineSnippet`은 "인쇄 가능 ASCII만"이었다. 산문에는 쓸 수 없다 — 한국어
 * 아티클의 재료는 한국어 산문이다. 그래서 **허용 집합을 한글까지 넓히되 그 이상은 넓히지
 * 않는다**: 한글 + ASCII + 닫힌 구두점 목록. 가나·한자·키릴·아랍 문자가 한 글자라도 있으면
 * 그 레코드는 서사 재료가 되지 못한다.
 *
 * 이것이 왜 탐지 규칙을 늘리는 것과 다른가: **공격 언어가 늘어도 약해지지 않는다.**
 * 허용목록은 "우리가 쓰는 문자"를 세는 것이지 "공격이 쓰는 문자"를 세는 것이 아니다.
 * 새 언어로 된 인젝션은 전부 자동으로 걸린다.
 *
 * **남는 구멍은 하나이고 숨기지 않는다: 한국어·영어로 쓰인 인젝션.** 그 축은 허용목록을
 * 통과하고, T-040의 탐지기가 맡는다. 다행히 그 축이야말로 T-040이 실제로 측정한 축이다
 * (미탐으로 보고된 것은 일본어였다). 즉 두 방어의 담당 구역이 서로를 덮는다:
 * 탐지기는 한/영을, 허용목록은 나머지 전부를. 그래도 **한/영 인젝션의 미탐분은 이 경로로
 * 초안 프롬프트까지 들어온다.** 그 잔여 위험은 (a) 프롬프트의 데이터 프레이밍 조항(NFR-05),
 * (b) 초안이 사람 편집을 거쳐야만 발행된다는 §0-5의 마지막 방어선이 받는다. 자동으로
 * 닫히지 않는다 — T-034의 레드팀 축으로 넘긴다(Findings).
 *
 * ### 판단 4: 시크릿은 산문 경로에서 **형상으로** 막는다
 *
 * T-004 포스트모템 §4.4①의 면제 경로(F-21·F-18)는 자격증명이 **무플래그로** 저장되게 한다.
 * 겹 2(`sanitizeFlags` 비어 있음)는 그래서 충분하지 않다. `containsSecretShape`(T-030 F-4)를
 * 산문에도 돌리고, 거기에 하나를 더한다: **`://`를 포함한 문단은 통째로 뺀다.**
 *
 * `://`를 세는 것은 열거가 아니라 형상이다. T-004가 8라운드를 돈 축(userinfo 문자 집합,
 * authority 종료 문자, 호스트 모양)은 전부 "`@` 앞뒤에 무엇이 올 수 있는가"의 열거였고,
 * 라운드마다 새 미탐이 열렸다. `://`는 그 열거의 **상위 앵커**라 우회가 불가능하다 —
 * 접속 문자열은 스킴 없이 쓸 수 없다. 대가는 URL을 언급한 문단 하나가 서사 재료에서
 * 빠지는 것뿐이고, 그 URL 자체는 이미 팩트 팩의 `signals`에 (스크린을 통과한 경우) 들어 있다.
 */
import type { ChunkSection, RecordSchema } from "@sentinel/contracts";

import { compareStrings } from "../facts/order.js";
import { containsSecretShape } from "../facts/screen.js";
import type { ArticleFacts } from "../facts/types.js";
import { detectInjection } from "../sanitizer/injection.js";

import { PUBLISHER_DEFAULTS } from "./config.js";

/**
 * 서사 재료로 실리는 본문 칸. `ChunkSection`에 `title`·`summary`를 더한 **상위 집합**이다.
 * `ChunkSection`을 재정의하는 것이 아니라 그대로 쓰고 둘을 덧붙인다(CLAUDE.md 계약 규칙).
 */
export type NarrativeSection = ChunkSection | "title" | "summary";

/** 산문이 재료가 되지 못한 사유. **조용히 사라지는 산문은 없다.** */
export const NARRATIVE_EXCLUSION_REASONS = [
  /** 팩트 팩의 소스 집합에 없다 = `screenMaterial`이 이미 걸렀거나 애초에 재료가 아니다. */
  "not-material",
  /** `sanitizeFlags`가 붙어 있다 (§7 원문 인용 금지). */
  "sanitize-flagged",
  /** 발행 직전 재판정에서 인젝션이 잡혔다 (T-040 규칙). */
  "injection-detected",
  /** 한글·ASCII·허용 구두점 밖의 문자가 있다 (판단 3). */
  "non-allowlisted-script",
  /** 시크릿 형상이 있다 (`containsSecretShape`, T-030 F-4). */
  "secret-shape",
  /** `://`가 있다 — 접속 문자열의 상위 앵커 (판단 4). */
  "uri-shape",
  /** 빈 문자열. */
  "empty",
  /** 겹을 통과한 칸이 하나도 남지 않았다. */
  "no-usable-prose",
] as const;

export type NarrativeExclusionReason = (typeof NARRATIVE_EXCLUSION_REASONS)[number];

/** 빠진 산문 1건. `section`이 없으면 **레코드 전체**가 빠졌다는 뜻이다. */
export interface NarrativeExclusion {
  readonly recordId: string;
  readonly section?: NarrativeSection;
  readonly reason: NarrativeExclusionReason;
}

/** 겹을 통과한 본문 칸 하나. */
export interface NarrativePart {
  readonly section: NarrativeSection;
  /** 상한을 넘으면 문장 경계에서 잘린 뒤의 값. */
  readonly text: string;
  readonly truncated: boolean;
}

/** 서사 재료 레코드 1건. 구조화 필드는 팩트 팩과 중복이지만 **문맥 없는 산문은 쓸 수 없다.** */
export interface NarrativeRecord {
  readonly recordId: string;
  readonly type: RecordSchema["type"];
  readonly severity: RecordSchema["severity"];
  readonly tags: readonly string[];
  /** ISO 날짜(YYYY-MM-DD). 팩트 팩의 타임라인과 같은 값이다. */
  readonly createdAt: string;
  readonly parts: readonly NarrativePart[];
}

export interface NarrativeSource {
  readonly records: readonly NarrativeRecord[];
  readonly excluded: readonly NarrativeExclusion[];
}

/** 감사용 요약. `lintReport`에 실려 "무엇을 모델에 보여 줬나"가 기록으로 남는다. */
export interface NarrativeReport {
  readonly records: number;
  readonly parts: number;
  readonly truncatedParts: number;
  readonly excluded: readonly NarrativeExclusion[];
}

/**
 * 한글 + ASCII(개행·탭 포함) + **닫힌 구두점 목록**.
 *
 * `\s`를 쓰지 않는다 — JS의 `\s`는 NBSP(U+00A0)와 U+2028·U+FEFF까지 포함하고,
 * T-004 F-18이 보인 대로 **비가시 문자는 자격증명을 숨기는 자리**다. 개행·탭·스페이스만 연다.
 */
const ALLOWED_PUNCTUATION = "§°±·–—‘’“”…←→≤≥";
const ALLOWED_PROSE_RE = new RegExp(
  `^[\\n\\r\\t\\x20-\\x7E\\uAC00-\\uD7A3\\u1100-\\u11FF\\u3130-\\u318F${ALLOWED_PUNCTUATION}]*$`,
);

/** 접속 문자열의 상위 앵커. 판단 4 참조. */
const URI_SCHEME_RE = /:\/\//;

/** 문장 끝. 잘라낼 때 문장 한복판에서 끊지 않기 위한 것이며, 판정에는 쓰이지 않는다. */
const SENTENCE_END_RE = /[.!?](?=\s|$)/g;

export function isAllowedProseScript(text: string): boolean {
  return ALLOWED_PROSE_RE.test(text);
}

export interface NarrativeSourceInput {
  readonly records: readonly RecordSchema[];
  readonly facts: ArticleFacts;
  readonly partMaxChars?: number;
}

/**
 * 레코드 → 서사 재료. **순수 함수이고 결정론이다** — 팩트 추출기와 같은 규약이라
 * 같은 입력이면 같은 프롬프트가 나가고 eval이 재현된다.
 */
export function buildNarrativeSource(input: NarrativeSourceInput): NarrativeSource {
  const limit = input.partMaxChars ?? PUBLISHER_DEFAULTS.NARRATIVE_PART_MAX_CHARS;
  const allowed = new Set(input.facts.sourceRecordIds);
  const records: NarrativeRecord[] = [];
  const excluded: NarrativeExclusion[] = [];

  for (const record of [...input.records].sort((a, b) => compareStrings(a._id, b._id))) {
    if (!allowed.has(record._id)) {
      excluded.push({ recordId: record._id, reason: "not-material" });
      continue;
    }
    if (record.sanitizeFlags.length > 0) {
      excluded.push({ recordId: record._id, reason: "sanitize-flagged" });
      continue;
    }

    const candidates = narrativeParts(record);
    const joined = candidates.map((part) => part.text).join("\n");

    if (detectInjection(joined).length > 0) {
      excluded.push({ recordId: record._id, reason: "injection-detected" });
      continue;
    }
    if (!isAllowedProseScript(joined)) {
      excluded.push({ recordId: record._id, reason: "non-allowlisted-script" });
      continue;
    }

    const parts: NarrativePart[] = [];
    for (const candidate of candidates) {
      const reason = partRejection(candidate.text);
      if (reason !== undefined) {
        excluded.push({ recordId: record._id, section: candidate.section, reason });
        continue;
      }
      parts.push(truncate(candidate, limit));
    }

    if (parts.length === 0) {
      excluded.push({ recordId: record._id, reason: "no-usable-prose" });
      continue;
    }

    records.push({
      recordId: record._id,
      type: record.type,
      severity: record.severity,
      tags: [...record.tags],
      createdAt: record.createdAt.toISOString().slice(0, 10),
      parts,
    });
  }

  return { records, excluded };
}

export function summarizeNarrative(source: NarrativeSource): NarrativeReport {
  const parts = source.records.flatMap((record) => record.parts);
  return {
    records: source.records.length,
    parts: parts.length,
    truncatedParts: parts.filter((part) => part.truncated).length,
    excluded: source.excluded,
  };
}

/**
 * 프롬프트에 실릴 형태. **데이터 프레이밍**이다(NFR-05) — 산문을 맨몸으로 이어 붙이지 않고
 * 속성이 붙은 블록 안에 넣어 "이것은 참고 데이터다"를 구조로 알린다.
 * `generator/context.ts`가 청크를 같은 방식으로 감싼다.
 */
export function renderNarrativeSource(source: NarrativeSource): string {
  return source.records
    .map((record) => {
      const head =
        `<record id="${record.recordId}" type="${record.type}" ` +
        `severity="${record.severity}" created="${record.createdAt}" ` +
        `tags="${record.tags.join(", ")}">`;
      const body = record.parts
        .map((part) => `  <${part.section}>${part.text}</${part.section}>`)
        .join("\n");
      return `${head}\n${body}\n</record>`;
    })
    .join("\n");
}

/** 유형별로 서사에 필요한 칸. `facts/extract.ts`의 `sections()`에 제목·요약을 더한 것이다. */
function narrativeParts(record: RecordSchema): { section: NarrativeSection; text: string }[] {
  const common: { section: NarrativeSection; text: string }[] = [
    { section: "title", text: record.title },
    { section: "summary", text: record.summary },
  ];
  if (record.type === "incident") {
    return [
      ...common,
      { section: "symptom", text: record.symptom },
      ...(record.rootCause === undefined
        ? []
        : [{ section: "rootCause" as NarrativeSection, text: record.rootCause }]),
      { section: "resolution", text: record.resolution },
      ...(record.prevention === undefined
        ? []
        : [{ section: "prevention" as NarrativeSection, text: record.prevention }]),
    ];
  }
  return [
    ...common,
    { section: "expected", text: record.expected },
    { section: "actual", text: record.actual },
    { section: "correction", text: record.correction },
  ];
}

/** 칸 하나가 빠지는 사유. 통과면 `undefined`. */
function partRejection(text: string): NarrativeExclusionReason | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "empty";
  if (URI_SCHEME_RE.test(trimmed)) return "uri-shape";
  if (containsSecretShape(trimmed)) return "secret-shape";
  return undefined;
}

/** 상한을 넘으면 **마지막 문장 경계**에서 자른다. 경계가 없으면 그냥 자른다. */
function truncate(
  candidate: { section: NarrativeSection; text: string },
  limit: number,
): NarrativePart {
  const text = candidate.text.trim();
  if (text.length <= limit) {
    return { section: candidate.section, text, truncated: false };
  }
  const head = text.slice(0, limit);
  let cut = -1;
  for (const match of head.matchAll(SENTENCE_END_RE)) {
    cut = match.index + 1;
  }
  return {
    section: candidate.section,
    text: (cut > 0 ? head.slice(0, cut) : head).trim(),
    truncated: true,
  };
}
