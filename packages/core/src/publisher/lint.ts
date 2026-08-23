/**
 * 문체 린터 — specs/08-publishing.md §4 "문체 린트 규칙 (자동, 규칙 기반)".
 * **LLM을 부르지 않는다.** 전부 결정론적 규칙이고, 같은 본문이면 같은 리포트가 나온다.
 *
 * ## "AI 티"를 무엇으로 판정하는가 — 그리고 무엇으로 판정하지 **않는가**
 *
 * §0이 전제를 정해 뒀다: **"AI 냄새가 나는 글의 공통점은 문체가 아니라 내용 없음이다."**
 * 그래서 이 파일의 10개 규칙은 "좋은 글"의 정의가 아니라 **"확실히 나쁜 글"의 열거**다.
 * 통과는 품질의 증거가 아니고, 실패만이 증거다. 이 비대칭이 설계의 핵심이다.
 *
 * 그래서 **총점이 없다.** 위반 목록만 있고 0..1 점수가 없는 것은 누락이 아니라 결정이다 —
 * 점수를 내놓는 순간 재작성 루프는 그 점수를 올리는 최적화가 되고, 규칙이 대리 지표에서
 * 목표로 승격한다(굿하트). 위반 목록은 "0이 되면 끝"이라 올릴 여지가 없다.
 *
 * ## 굿하트 위험 — 어디가 뚫리고 무엇이 그것을 막는가
 *
 * 규칙 10개는 성질이 둘로 갈린다.
 *
 * - **표면 규칙**(`banned-phrase`·`emoji`·`hype-chain`·`ending-repetition`·`meta-opening`·
 *   `symmetric-triples`·`uniform-paragraphs`·`bullet-per-heading`)은 **싸게 우회된다.**
 *   "결론적으로"를 "요컨대"로 바꾸면 통과하고, 글은 하나도 나아지지 않는다. 이 축에서
 *   린터는 바닥이지 목표가 아니며, **린터가 통과시킨 글이 좋은 글이라는 주장은 여기서 할 수 없다.**
 *   그 판정은 §6의 블라인드 LLM-judge, 즉 T-034의 몫이다. (Findings 참조.)
 *
 * - **밀도 규칙**(`fact-density`·`missing-code-block`)은 우회가 싸지 않다. 1000자당 구체
 *   팩트 3개와 코드/로그 블록 1개는 **재료 없이는 만들 수 없고**, 지어내서 채우면
 *   `factcheck.ts`가 그 수치·인용이 팩트 팩에 실재하는지 대조해 반려한다.
 *   즉 두 게이트가 서로를 잠근다: 밀도는 숫자를 늘리라 요구하고, 팩트 대조는 늘린 숫자가
 *   실재할 것을 요구한다. **한쪽을 속이면 다른 쪽이 깨진다.** 이것이 이 태스크에서 팩트
 *   대조가 본체인 이유이고, 린터 단독으로는 굿하트를 못 막는다는 사실의 다른 표현이다.
 *
 * 구조 획일화는 규칙으로 잡는 것에 더해 **원인 쪽에서도** 친다: `templates.ts`가 유형마다
 * 서사 골격 3종을 로테이션한다. 검사기를 통과하도록 다듬는 것보다 애초에 다른 골격으로
 * 쓰게 하는 편이 굿하트에 강하다.
 */

/** §4의 규칙 목록. 이름은 스펙의 항목과 1:1로 대응한다. */
export const LINT_RULES = [
  /** 금지 표현 — 스펙이 열거한 상투구. */
  "banned-phrase",
  /** 이모지. */
  "emoji",
  /** 과장 수식 연쇄. */
  "hype-chain",
  /** 3개 항목 대칭 나열이 2회 이상. */
  "symmetric-triples",
  /** 모든 문단이 같은 길이(±1문장). */
  "uniform-paragraphs",
  /** 소제목마다 불릿 목록. */
  "bullet-per-heading",
  /** 본문 1000자당 구체 팩트 3개 미만. */
  "fact-density",
  /** 코드/로그 블록이 하나도 없음. */
  "missing-code-block",
  /** 연속 5문장 동일 어미. */
  "ending-repetition",
  /** "이 글에서는 ~를 다룹니다"류 메타 서두. */
  "meta-opening",
] as const;

export type LintRuleId = (typeof LINT_RULES)[number];

export interface LintViolation {
  readonly rule: LintRuleId;
  /** 무엇이 왜 걸렸는가. 재작성 지시문에 그대로 실린다. */
  readonly detail: string;
}

export interface LintMetrics {
  readonly bodyChars: number;
  readonly paragraphs: number;
  readonly sentences: number;
  readonly headings: number;
  readonly codeBlocks: number;
  readonly concreteFacts: number;
  /** 1000자당 구체 팩트. §4의 밀도 하한이 비교되는 값이다. */
  readonly factsPerThousandChars: number;
}

export interface LintReport {
  /** 린트 규칙 집합의 형상 버전. 저장된 리포트를 나중에 읽을 때 해석 기준이 된다. */
  readonly lintVersion: 1;
  readonly passed: boolean;
  readonly violations: readonly LintViolation[];
  readonly metrics: LintMetrics;
}

/**
 * **스펙이 열거한 금지 표현 그대로다.** 여기에 임의로 항목을 더하지 않는다 —
 * 목록을 늘리는 것은 문체 정책을 바꾸는 일이고, 그건 specs/08 §4를 고치는 결정이다
 * (CLAUDE.md 최우선 원칙 1). `~`는 스펙의 자리표시자라 고정 부분만 남긴다.
 */
export const BANNED_PHRASES: readonly string[] = [
  "결론적으로",
  "라고 할 수 있습니다",
  "주목할 만한 점은",
  "혁신적인",
  "게임체인저",
  "하는 것이 중요합니다",
];

/**
 * "과장 수식"의 목록. **스펙에 정의가 없어 여기서 정한다**(T-030 F-3과 같은 성격의 해석).
 * 판정은 낱개가 아니라 **연쇄** — 한 문장에 둘 이상일 때만 걸린다. 낱개까지 잡으면
 * "매우 느리다" 같은 정상 서술이 전부 위반이 되어 규칙이 곧 무시된다.
 */
export const HYPE_MODIFIERS: readonly string[] = [
  "매우",
  "정말",
  "굉장히",
  "엄청난",
  "놀라운",
  "획기적인",
  "압도적인",
  "완벽한",
  "최고의",
  "탁월한",
];

/**
 * 메타 서두. §4: "'이 글에서는 ~를 다룹니다'류 메타 서두 금지 — 사건 한복판에서 시작".
 * **첫 문단만 본다** — 본문 중간의 "살펴보겠습니다"는 서두가 아니다.
 */
export const META_OPENERS: readonly string[] = [
  "이 글에서는",
  "이번 글에서는",
  "본 글에서는",
  "이 문서에서는",
  "이번 포스트에서는",
  "다루어 보겠습니다",
  "다뤄 보겠습니다",
  "살펴보겠습니다",
  "알아보겠습니다",
  "소개하겠습니다",
];

/** §4 밀도 하한: 본문 1000자당 구체 팩트 3개 이상. */
export const MIN_FACTS_PER_THOUSAND_CHARS = 3;
/** §4: "연속 5문장 동일 어미 금지". */
export const MAX_SAME_ENDING_RUN = 4;
/** §4: "3개 항목 대칭 나열이 2회 이상 반복". */
export const MAX_SYMMETRIC_TRIPLES = 1;
/** ±1문장 판정을 적용할 최소 문단 수. 문단이 둘뿐이면 "모든 문단"이라 부를 수 없다. */
export const UNIFORM_PARAGRAPH_MIN = 3;
/** "소제목마다 불릿"을 판정할 최소 소제목 수. */
export const BULLET_HEADING_MIN = 2;

const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const BULLET_RE = /^\s*(?:[-*+]\s+|\d+\.\s+)\S/;
const FENCE_RE = /^\s*```/;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const DIGIT_RUN_RE = /\d+/g;
/**
 * 날짜 한 개는 **구체 팩트 한 개**다. 숫자런으로만 세면 `2026-03-02`가 셋으로 불어나
 * 날짜를 나열한 글이 밀도 하한을 공짜로 넘는다 — 게이트가 조용히 무력해지는 모양이다.
 * 그래서 날짜를 먼저 세고 걷어낸 뒤에 남은 숫자런을 센다.
 */
const DATE_LIKE_RE = /\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{4}년\s?\d{1,2}월\s?\d{1,2}일|\d{1,2}월\s?\d{1,2}일/g;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const SENTENCE_END_RE = /[.!?]+(?=\s|$)/g;
const HANGUL_PAIR_RE = /^[가-힣]{2}$/;
const SENTENCE_TAIL_NOISE_RE = /[\s.!?"'`)\]…]+$/;

/** 본문을 구조로 편 결과. 규칙들이 같은 파싱을 공유하도록 한 번만 만든다. */
export interface BodyShape {
  readonly fences: readonly string[];
  /** 코드 펜스를 걷어낸 나머지. */
  readonly prose: string;
  readonly headings: readonly string[];
  /** 소제목·불릿이 아닌 산문 문단. */
  readonly paragraphs: readonly string[];
  /** 연속한 불릿 항목의 묶음. 각 원소는 그 묶음의 항목 수. */
  readonly bulletGroups: readonly number[];
  /** 소제목별로 그 구간에 불릿이 있었는가. */
  readonly headingHasBullet: readonly boolean[];
  readonly inlineCode: readonly string[];
  readonly sentences: readonly string[];
}

export function analyzeBody(body: string): BodyShape {
  const lines = body.split("\n");
  const fences: string[] = [];
  const proseLines: string[] = [];
  const headings: string[] = [];
  const headingHasBullet: boolean[] = [];
  const bulletGroups: number[] = [];

  let inFence = false;
  let fenceBuffer: string[] = [];
  let bulletRun = 0;

  const closeBulletRun = (): void => {
    if (bulletRun > 0) bulletGroups.push(bulletRun);
    bulletRun = 0;
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (inFence) {
        fences.push(fenceBuffer.join("\n"));
        fenceBuffer = [];
        inFence = false;
      } else {
        closeBulletRun();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }

    proseLines.push(line);

    if (HEADING_RE.test(line)) {
      closeBulletRun();
      headings.push(line.replace(/^\s*#+\s*/, "").trim());
      headingHasBullet.push(false);
      continue;
    }
    if (BULLET_RE.test(line)) {
      bulletRun += 1;
      if (headingHasBullet.length > 0) headingHasBullet[headingHasBullet.length - 1] = true;
      continue;
    }
    closeBulletRun();
  }

  // 닫히지 않은 펜스도 코드로 본다 — 열린 채로 끝난 본문에서 코드가 산문으로 세면
  // 밀도 계산이 조용히 부풀고, 그 상태가 정확히 "린터를 속이는" 모양이다.
  if (inFence) fences.push(fenceBuffer.join("\n"));
  closeBulletRun();

  const prose = proseLines.join("\n");
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.trim().length > 0 && !HEADING_RE.test(line) && !BULLET_RE.test(line))
        .join(" ")
        .trim(),
    )
    .filter((block) => block.length > 0);

  return {
    fences,
    prose,
    headings,
    paragraphs,
    bulletGroups,
    headingHasBullet,
    inlineCode: [...prose.matchAll(INLINE_CODE_RE)].map((match) => match[0]),
    sentences: paragraphs.flatMap((paragraph) => splitSentences(paragraph)),
  };
}

/**
 * 문체 린트. 위반이 하나라도 있으면 `passed:false`이고, 그 목록이 재작성 지시문이 된다.
 *
 * **팩트 팩을 받지 않는다.** 밀도는 "구체 팩트처럼 생긴 것이 몇 개인가"를 세는 형상 판정이고,
 * 그 팩트가 **실재하는가**는 `factcheck.ts`가 판정한다. 둘을 한 함수에 합치면 린트 실패와
 * 팩트 위반이 같은 재작성 루프에 섞이고, §4가 정한 순서(린트 루프 → 팩트 대조)가 사라진다.
 */
export function lintDraft(body: string): LintReport {
  const shape = analyzeBody(body);
  const violations: LintViolation[] = [];

  for (const phrase of BANNED_PHRASES) {
    if (body.includes(phrase)) {
      violations.push({ rule: "banned-phrase", detail: `금지 표현 "${phrase}"이(가) 있다.` });
    }
  }

  if (EMOJI_RE.test(body)) {
    violations.push({ rule: "emoji", detail: "이모지가 있다." });
  }

  for (const sentence of shape.sentences) {
    const hits = HYPE_MODIFIERS.filter((word) => sentence.includes(word));
    if (hits.length >= 2) {
      violations.push({
        rule: "hype-chain",
        detail: `한 문장에 과장 수식이 ${String(hits.length)}개 연쇄한다: ${hits.join(", ")}`,
      });
    }
  }

  const triples =
    shape.bulletGroups.filter((size) => size === 3).length + countSentenceTriples(shape.sentences);
  if (triples > MAX_SYMMETRIC_TRIPLES) {
    violations.push({
      rule: "symmetric-triples",
      detail: `3개 항목 대칭 나열이 ${String(triples)}회 반복된다 (허용 ${String(MAX_SYMMETRIC_TRIPLES)}회).`,
    });
  }

  const sentenceCounts = shape.paragraphs.map((paragraph) => splitSentences(paragraph).length);
  if (sentenceCounts.length >= UNIFORM_PARAGRAPH_MIN) {
    const spread = Math.max(...sentenceCounts) - Math.min(...sentenceCounts);
    if (spread <= 1) {
      violations.push({
        rule: "uniform-paragraphs",
        detail: `문단 ${String(sentenceCounts.length)}개의 문장 수가 전부 ±1 안에 있다 (${sentenceCounts.join(", ")}).`,
      });
    }
  }

  if (
    shape.headings.length >= BULLET_HEADING_MIN &&
    shape.headingHasBullet.every((hasBullet) => hasBullet)
  ) {
    violations.push({
      rule: "bullet-per-heading",
      detail: `소제목 ${String(shape.headings.length)}개가 전부 불릿 목록을 달고 있다.`,
    });
  }

  const metrics = measure(body, shape);
  if (metrics.factsPerThousandChars < MIN_FACTS_PER_THOUSAND_CHARS) {
    violations.push({
      rule: "fact-density",
      detail:
        `1000자당 구체 팩트가 ${metrics.factsPerThousandChars.toFixed(2)}개다 ` +
        `(하한 ${String(MIN_FACTS_PER_THOUSAND_CHARS)}개). 수치·날짜·명령어·에러 원문을 더 넣어라.`,
    });
  }
  if (metrics.codeBlocks === 0) {
    violations.push({
      rule: "missing-code-block",
      detail: "코드/로그 블록이 하나도 없다 (하한 1개).",
    });
  }

  const run = longestEndingRun(shape.sentences);
  if (run.length > MAX_SAME_ENDING_RUN) {
    violations.push({
      rule: "ending-repetition",
      detail: `"${run.ending}" 어미가 연속 ${String(run.length)}문장 반복된다 (허용 ${String(MAX_SAME_ENDING_RUN)}문장).`,
    });
  }

  const opening = shape.paragraphs[0];
  if (opening !== undefined) {
    const opener = META_OPENERS.find((phrase) => opening.includes(phrase));
    if (opener !== undefined) {
      violations.push({
        rule: "meta-opening",
        detail: `첫 문단이 메타 서두 "${opener}"로 시작한다. 사건 한복판에서 시작해라.`,
      });
    }
  }

  return { lintVersion: 1, passed: violations.length === 0, violations, metrics };
}

function measure(body: string, shape: BodyShape): LintMetrics {
  // 인라인 코드는 낱개로 세므로 숫자 세기에서 뺀다 — 안 빼면 `27017` 하나가 둘로 센다.
  const proseWithoutCode = shape.prose.replace(INLINE_CODE_RE, " ");
  const dates = [...proseWithoutCode.matchAll(DATE_LIKE_RE)].length;
  const digitRuns = [...proseWithoutCode.replace(DATE_LIKE_RE, " ").matchAll(DIGIT_RUN_RE)].length;
  const concreteFacts = dates + digitRuns + shape.inlineCode.length + shape.fences.length;
  const bodyChars = body.length;
  return {
    bodyChars,
    paragraphs: shape.paragraphs.length,
    sentences: shape.sentences.length,
    headings: shape.headings.length,
    codeBlocks: shape.fences.length,
    concreteFacts,
    factsPerThousandChars: bodyChars === 0 ? 0 : (concreteFacts * 1000) / bodyChars,
  };
}

/**
 * 문장 분리. **마침표 뒤에 공백이나 문자열 끝이 와야** 경계로 본다 —
 * 그렇지 않으면 `v1.2.3`이나 `pnpm-lock.yaml`이 문장 셋으로 쪼개지고,
 * 어미·문단 길이 판정이 전부 잡음이 된다.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    if (match.index === undefined) continue;
    const end = match.index + match[0].length;
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * 어미 = 문장 끝의 **한글 두 글자**. 한 글자(`다`)로 잡으면 한국어 서술문이 전부 같은 어미가
 * 되어 규칙이 항상 발동하고, 세 글자로 잡으면 `합니다`/`했습니다`가 다른 어미가 되어
 * 규칙이 거의 발동하지 않는다. 두 글자는 `했다`/`한다`/`이다`를 가르면서 `합니다`/`했습니다`를
 * 같은 `니다`로 묶는다. **근사이고, 근사임을 여기 적어 둔다.**
 */
export function sentenceEnding(sentence: string): string | null {
  const core = sentence.replace(SENTENCE_TAIL_NOISE_RE, "");
  const tail = core.slice(-2);
  return HANGUL_PAIR_RE.test(tail) ? tail : null;
}

function longestEndingRun(sentences: readonly string[]): { ending: string; length: number } {
  let best = { ending: "", length: 0 };
  let current: string | null = null;
  let length = 0;
  for (const sentence of sentences) {
    const ending = sentenceEnding(sentence);
    if (ending !== null && ending === current) {
      length += 1;
    } else {
      current = ending;
      length = ending === null ? 0 : 1;
    }
    if (current !== null && length > best.length) best = { ending: current, length };
  }
  return best;
}

/**
 * 문장 안의 3항 대칭 나열. `A, B, C` 꼴에서 세 항이 모두 짧고 다른 구두점이 없을 때만 센다.
 * 느슨하게 잡으면 정상 서술의 쉼표가 전부 걸리므로 **조인 쪽으로 틀렸다** — 이 규칙은
 * 표면 규칙이라 놓치는 비용보다 오탐의 비용이 크다(파일 서두의 굿하트 논의 참조).
 */
const TRIPLE_ITEM_MAX_CHARS = 24;

function countSentenceTriples(sentences: readonly string[]): number {
  let count = 0;
  for (const sentence of sentences) {
    const parts = sentence.split(",");
    if (parts.length !== 3) continue;
    const items = parts.map((part) => part.replace(/^(?:그리고|또한)\s*/, "").trim());
    if (items.every((item) => item.length > 0 && item.length <= TRIPLE_ITEM_MAX_CHARS)) {
      count += 1;
    }
  }
  return count;
}
