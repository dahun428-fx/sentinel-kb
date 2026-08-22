/**
 * 인용 후처리 검증. 출처: specs/03-rag-pipeline.md §5, specs/05 "Eval 2 (a)", NFR-02.
 *
 * > 응답을 문장 분할 → 각 주장 문장에 유효한 `[REC-...#...]`이 있고 **그 ID가 실제 컨텍스트에
 * > 있었는지** 확인. 위반 시 1회 재생성, 재차 위반이면 인용 없는 문장을 제거하고
 * > `groundingViolation: true` 로깅.
 *
 * ## T-019가 남긴 구멍이 이것이다 (M5b, 실측 생존)
 *
 * `FoundResult.citations`는 **답변 텍스트가 아니라 검색 컨텍스트**에서 만들어진다
 * (`context.chunks.map(c => c.citation)`). 그래서 모델이 인용 마커를 하나도 안 붙인 답을
 * 내놔도 응답은 `found:true` + `citations:[...]`였다 — 인용이 있는 것처럼 보이지만 **답변의
 * 어느 문장도 그 인용에 묶여 있지 않다.** `toAnswerBody`의 `citations.min(1)`은 배열의
 * 길이만 보므로 이 상태를 통과시킨다. 이 모듈이 그 구멍을 닫는다.
 *
 * ## 결정 1: "주장 문장"을 무엇으로 볼 것인가
 *
 * specs/03 §5도 specs/05도 정의하지 않았다. **결정: 구조 요소를 뺀 모든 문장이 주장 문장이다.**
 * 면제 대상은 의미가 아니라 **형태**로만 정한다(제목, 코드 블록, 목록 마커, 표, 구분선,
 * 짧은 라벨). "안녕하세요"도 주장 문장이고, 인용이 없으면 제거된다. 근거는 셋이다.
 *
 *  1. **프롬프트가 이미 그렇게 요구한다.** `prompts/answer.md` 조항 2는 "인용을 붙일 수 없는
 *     문장은 쓰지 않는다"이다. 인사말은 그 조항 위반이지 검증기가 봐 줘야 할 예외가 아니다.
 *  2. **의미 판정을 넣으면 검증기가 곧 공격면이 된다.** "이건 주장이 아니다"를 모델이나
 *     휴리스틱이 정하는 순간, 근거 없는 문장을 그 면제 칸에 밀어 넣는 것이 우회로가 된다.
 *     면제 집합이 모델 판단으로 정해지는 grounding 검사는 grounding 검사가 아니다.
 *  3. **오탐과 미탐의 비용이 비대칭이다.** 오탐은 인사말 한 줄이 지워지는 것이고, 미탐은
 *     근거 없는 해결책이 그대로 나가는 것이다(NFR-02가 막으려는 바로 그것).
 *
 * 구조 요소만 면제하는 이유는 그것들이 **문장이 아니기** 때문이다 — `## 원인 가설`이나
 * ```` ```bash ```` 줄은 주장을 담지 않고, 뒤에 인용을 붙이면 프롬프트가 요구한 출력 형식이
 * 깨진다. 면제는 전부 형태 규칙이고 길이 상한이 걸려 있어(`LABEL_MAX_CHARS`) 산문이
 * 라벨로 위장해 빠져나갈 수 없다.
 *
 * ## 결정 2: 한국어 문장 분할
 *
 * 마침표 단순 분할은 시드 본문에서 즉시 깨진다 — 실제로 들어 있는 것들이다:
 * `0.033`(SELF-01), `proxy_read_timeout 3600s`(INC-06), `1/(k+rank)`, `v1.2`, `specs/03 §5`,
 * 그리고 프롬프트가 지시하는 `1. **원인 가설**` 목록 마커. 그래서 규칙은 이렇다.
 *
 *  - 종결 문자(`.` `!` `?` `…`)가 **공백이나 줄 끝 앞에 있을 때만** 자른다.
 *    `1.5`·`v1.2`·`specs/03`은 점 뒤가 공백이 아니라 애초에 자를 자리가 없다.
 *  - 줄바꿈은 언제나 경계다. 목록·표·제목이 한 문장으로 붙지 않는다.
 *  - 코드 펜스 안과 인라인 코드(백틱) 안에서는 자르지 않는다. `nginx -s reload.`가
 *    코드로 인용될 때 문장이 되어 인용을 요구받지 않게 한다.
 *  - 줄 머리의 `1.`·`- 2.`는 목록 마커다. 자르면 "1"이 인용 없는 문장이 된다.
 *  - `e.g.`·`i.e.`·`etc.` 같은 약어는 자르지 않는다.
 *  - 문장 끝 인용은 **마침표 뒤에 올 수도 있다**(`...했다. [REC-x#y]`). 자른 뒤 같은 줄에서
 *    이어지는 `[REC-...]`는 **앞 문장으로 끌어온다.** 안 그러면 근거가 붙은 문장이
 *    "인용 없음"으로 오판되고, 다음 문장은 남의 근거를 빌려 통과한다.
 *
 * **분할은 손실이 없다.** 모든 조각은 `[start, end)` 오프셋을 갖고, 순서대로 이어 붙이면
 * 원문과 글자 하나까지 같다(`citation.spec.ts`가 시드 50건 본문과 프롬프트 원문으로 단언한다).
 * 손실이 있으면 "제거"가 제거가 아니라 재작성이 되고, 모델이 쓰지 않은 문장이 답변에 남는다.
 */

/** specs/03 §4 조항 2의 인용 형식. `context.ts`의 `citationFor`가 만드는 그 문자열이다. */
const CITATION_RE = /\[REC-[^\]\n]+\]/g;

/** 줄 머리에서 이어지는 인용 묶음을 앞 문장으로 끌어올 때 쓴다. */
const LEADING_CITATION_RE = /^\[REC-[^\]\n]+\]/;

/**
 * 라벨로 인정하는 최대 길이. 이 상한이 없으면 산문 한 문단을 `**...**`로 감싸는 것만으로
 * 검증을 통째로 우회할 수 있다. 값의 근거는 "제목·소절 라벨은 짧다"이지 튜닝이 아니다.
 */
const LABEL_MAX_CHARS = 40;

/** 문장이 주장 문장이 **아닌** 이유. 전부 형태 규칙이다 — 의미 판정은 하지 않는다. */
export const NON_CLAIM_REASONS = {
  /** 공백뿐. */
  BLANK: "blank",
  /** 코드 펜스 안 또는 펜스 표시 줄. */
  CODE: "code",
  /** 마크다운 제목. */
  HEADING: "heading",
  /** 구분선(`---`). */
  RULE: "rule",
  /** 표의 행. */
  TABLE: "table",
  /** 목록·인용 마커만 있고 본문이 없다. */
  MARKER: "marker",
  /** 짧은 라벨(`**원인 가설**`, `해결 절차:`). */
  LABEL: "label",
} as const;

export type NonClaimReason = (typeof NON_CLAIM_REASONS)[keyof typeof NON_CLAIM_REASONS];

/** 분할된 조각 1개. `[start, end)`는 원문 오프셋이고 조각들은 원문을 빈틈없이 덮는다. */
export interface AnswerSentence {
  readonly start: number;
  readonly end: number;
  /** 원문 조각 그대로(앞뒤 공백 포함). 제거·재조립이 원문을 보존하는 근거다. */
  readonly raw: string;
  /** 사람이 읽는 형태. 리포트·로그에 쓰고 재조립에는 쓰지 않는다. */
  readonly text: string;
  readonly claim: boolean;
  readonly nonClaimReason: NonClaimReason | null;
  /** 이 조각에 박힌 인용 문자열 전부(중복 제거하지 않는다 — 원본 사실이다). */
  readonly citations: string[];
}

/** 위반 1건. `kind`가 "인용이 없다"와 "지어냈다"를 가른다 — 원인이 다르다. */
export interface CitationViolation {
  /** `missing`: 유효 인용이 하나도 없다. `unknown`: 컨텍스트에 없는 ID를 인용했다. */
  readonly kind: "missing" | "unknown";
  /** 문장 순번(0부터). `sentences` 배열의 인덱스다. */
  readonly index: number;
  /** 문장 본문. **답변 텍스트이지 청크 본문이 아니다** — NFR-03의 대상이 아니다. */
  readonly text: string;
  /** `unknown`일 때 문제의 ID들. `missing`이면 비어 있다. */
  readonly citations: string[];
}

export interface CitationVerification {
  /** 주장 문장 전부가 유효 인용을 갖는가. 주장 문장이 0건이면 `false`다(아래 참조). */
  readonly ok: boolean;
  readonly sentences: AnswerSentence[];
  readonly claimCount: number;
  readonly citedClaimCount: number;
  readonly violations: CitationViolation[];
  /**
   * 컨텍스트에 없는데 인용된 ID(중복 제거·정렬). **모델이 그럴듯한 ObjectId를 지어낼 수 있다** —
   * 형식만 보는 검사는 그것을 통과시킨다. 이 배열이 비어 있지 않으면 지어낸 것이다.
   */
  readonly unknownCitations: string[];
}

/**
 * 답변을 문장으로 나눈다. 손실이 없다 — `spans.map(s => s.raw).join("") === text`.
 *
 * 줄 단위로 먼저 쪼개는 이유: 코드 펜스 상태가 줄 단위로 토글되고, 목록·표·제목 판정도
 * 줄 단위 형태 규칙이기 때문이다. 줄 안에서만 종결 문자를 본다.
 */
export function splitAnswerSentences(text: string): AnswerSentence[] {
  const sentences: AnswerSentence[] = [];
  let offset = 0;
  let inFence = false;

  for (const line of splitLines(text)) {
    const fenceLine = isFenceLine(line);
    const insideCode = inFence || fenceLine;
    if (fenceLine) inFence = !inFence;

    for (const [start, end] of insideCode
      ? [[0, line.length] as const]
      : sentenceRangesInLine(line)) {
      const raw = line.slice(start, end);
      sentences.push(makeSentence(offset + start, offset + end, raw, insideCode));
    }
    offset += line.length;
  }

  return sentences;
}

/**
 * 주장 문장의 인용을 검증한다. **`allowed`는 실제 컨텍스트에 실린 인용 문자열 집합이다** —
 * 형식이 맞는지가 아니라 **그 ID가 거기 있었는지**를 본다(specs/03 §5의 문면).
 *
 * `ok`는 주장 문장이 0건일 때도 `false`다. 주장이 하나도 없는 답변은 근거에 묶인 답변이
 * 아니라 **아무것도 주장하지 않는 텍스트**이고, 그것을 `found:true`로 내보내면 인용 배열만
 * 그럴듯한 응답이 된다 — M5b가 정확히 그 상태였다.
 */
export function verifyAnswerCitations(
  answer: string,
  allowed: readonly string[],
): CitationVerification {
  const allowedSet = new Set(allowed);
  const sentences = splitAnswerSentences(answer);
  const violations: CitationViolation[] = [];
  const unknown = new Set<string>();
  let claimCount = 0;
  let citedClaimCount = 0;

  sentences.forEach((sentence, index) => {
    for (const citation of sentence.citations) {
      if (!allowedSet.has(citation)) unknown.add(citation);
    }
    if (!sentence.claim) return;
    claimCount += 1;

    const bad = sentence.citations.filter((citation) => !allowedSet.has(citation));
    if (bad.length > 0) {
      violations.push({ kind: "unknown", index, text: sentence.text, citations: bad });
      return;
    }
    if (sentence.citations.length === 0) {
      violations.push({ kind: "missing", index, text: sentence.text, citations: [] });
      return;
    }
    citedClaimCount += 1;
  });

  return {
    ok: claimCount > 0 && violations.length === 0,
    sentences,
    claimCount,
    citedClaimCount,
    violations,
    unknownCitations: [...unknown].sort(),
  };
}

export interface StripResult {
  /** 위반 문장을 뺀 답변. 남은 조각은 **원문 그대로**다(재작성하지 않는다). */
  readonly text: string;
  /** 실제로 제거된 문장 수. */
  readonly removed: number;
  /**
   * 남은 텍스트가 답변으로 성립하는가 — 유효 인용을 가진 주장 문장이 하나라도 남았는가.
   * `false`면 `found:true`로 낼 수 없다. 인용 배열은 컨텍스트에서 나오므로 비어 있지 않고,
   * 그대로 내보내면 "본문은 아무것도 주장하지 않는데 인용은 붙어 있는" 응답이 된다.
   */
  readonly grounded: boolean;
}

/**
 * 위반 문장을 **제거한다**(specs/03 §5의 "인용 없는 문장을 제거"). 남은 조각은 손대지 않고,
 * 제거로 생긴 공백·빈 줄만 정리한다.
 */
export function stripUngroundedSentences(
  answer: string,
  verification: CitationVerification,
): StripResult {
  const removedIndexes = new Set(verification.violations.map((violation) => violation.index));
  const kept: string[] = [];
  let grounded = false;

  verification.sentences.forEach((sentence, index) => {
    if (removedIndexes.has(index)) return;
    kept.push(sentence.raw);
    if (sentence.claim && sentence.citations.length > 0) grounded = true;
  });

  const text = kept
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, removed: removedIndexes.size, grounded: grounded && text.length > 0 };
}

// ─────────────────────────────────────────────────────────────── 내부 구현

/** 줄 끝 문자를 붙인 채로 자른다. 이어 붙이면 원문이다. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function isFenceLine(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

/**
 * 한 줄 안의 문장 경계. 반환값은 줄 전체를 덮는 `[start, end)` 목록이다.
 *
 * 인라인 코드(백틱) 안에서는 자르지 않는다 — `` `nginx -s reload.` ``의 마침표가 문장을
 * 끝내면 코드 조각이 인용을 요구받는 주장 문장이 된다.
 */
function sentenceRangesInLine(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let inCode = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (char !== "." && char !== "!" && char !== "?" && char !== "…") continue;

    const next = line[i + 1];
    // 종결 문자 뒤가 공백이나 줄 끝일 때만 경계다. `1.5`·`v1.2`·`specs/03`은 여기서 걸러진다.
    if (next !== undefined && !/\s/.test(next)) continue;
    if (char === "." && isNonTerminalPeriod(line, start, i)) continue;

    const end = extendOverTrailingCitations(line, i + 1);
    ranges.push([start, end]);
    start = end;
    i = end - 1;
  }

  if (start < line.length) ranges.push([start, line.length]);
  return ranges;
}

/** 목록 마커(`1.`)와 약어(`e.g.`)의 마침표는 문장을 끝내지 않는다. */
function isNonTerminalPeriod(line: string, sentenceStart: number, dotIndex: number): boolean {
  const before = line.slice(sentenceStart, dotIndex);
  // 줄 머리의 `1.` / `- 2.` / `> 3.` — 자르면 "1"이 인용 없는 문장이 된다.
  if (/^[\s>]*(?:[-*+]\s*)?\d+$/.test(before)) return true;
  const word = /([A-Za-z][A-Za-z.]*)$/.exec(before)?.[1];
  return word !== undefined && ABBREVIATIONS.has(word.toLowerCase());
}

/** 마침표 뒤에 붙는 인용을 앞 문장으로 끌어온다. 줄바꿈은 넘지 않는다. */
function extendOverTrailingCitations(line: string, from: number): number {
  let end = from;
  for (;;) {
    let cursor = end;
    while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) cursor += 1;
    const match = LEADING_CITATION_RE.exec(line.slice(cursor));
    if (match === null) return end;
    end = cursor + match[0].length;
  }
}

/** 문장을 끝내지 않는 약어. 한국어 산문에서 실제로 나타나는 것만 담는다. */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "cf",
  "vs",
  "al",
  "approx",
  "resp",
  "ver",
  "vol",
  "fig",
]);

function makeSentence(
  start: number,
  end: number,
  raw: string,
  insideCode: boolean,
): AnswerSentence {
  const text = raw.trim();
  const reason = nonClaimReason(text, insideCode);
  return {
    start,
    end,
    raw,
    text,
    claim: reason === null,
    nonClaimReason: reason,
    citations: text.match(CITATION_RE) ?? [],
  };
}

/**
 * 주장 문장이 아닌 이유를 고른다. **전부 형태 규칙이다.**
 * 하나라도 의미 판정("이건 인사말이다")을 넣으면 그 칸이 우회로가 된다(모듈 주석 결정 1).
 */
function nonClaimReason(text: string, insideCode: boolean): NonClaimReason | null {
  if (text === "") return NON_CLAIM_REASONS.BLANK;
  if (insideCode) return NON_CLAIM_REASONS.CODE;
  if (/^#{1,6}\s/.test(text)) return NON_CLAIM_REASONS.HEADING;
  if (/^([-*_])[\s]*(?:\1[\s]*){2,}$/.test(text)) return NON_CLAIM_REASONS.RULE;
  if (text.startsWith("|")) return NON_CLAIM_REASONS.TABLE;

  const body = text.replace(/^(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/, "").trim();
  if (body === "") return NON_CLAIM_REASONS.MARKER;
  if (isLabel(body)) return NON_CLAIM_REASONS.LABEL;
  return null;
}

/**
 * 라벨인가. **짧고, 종결 문자가 없고, 통째로 강조됐거나 콜론으로 끝나는** 줄만 라벨이다.
 * 길이 상한이 핵심이다 — 없으면 문단을 `**...**`로 감싸는 것이 곧 우회로다.
 */
function isLabel(body: string): boolean {
  if (body.length > LABEL_MAX_CHARS) return false;
  if (/[.!?…]/.test(body)) return false;
  if (/[:：]$/.test(body)) return true;
  return /^(\*\*|__|\*|_)(?!\s)(.+?)(?<!\s)\1$/.test(body);
}
