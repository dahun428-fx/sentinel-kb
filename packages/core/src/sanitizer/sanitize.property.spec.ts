/**
 * T-004 Acceptance 3 — 프로퍼티 테스트.
 *
 * 단언은 하나다: **어떤 문맥에 심어도, 원문 시크릿의 어떤 조각도 결과에 남지 않는다.**
 * 예시 몇 개를 도는 건 프로퍼티가 아니다. 생성기로 시크릿과 주변 문맥을 모두 랜덤화한다.
 *
 * ## 이 파일이 과거에 미탐을 못 잡았던 이유
 *
 * 예전 생성기는 구현의 **좁힘 조건을 filter로 복사**했다 — "숫자를 1개 이상 포함",
 * "대·소문자를 모두 포함" 같은 것들. 그러면 표본이 "구현이 잡기로 한 것"으로 한정돼
 * "구현이 잡기로 하지 않은 실제 시크릿"은 애초에 생성되지 않는다. 테스트는
 * **구현이 자기 자신과 일치하는지**만 확인하고 미탐은 원리적으로 발견할 수 없다.
 * 그래서 실제로 숫자 없는 API 키와 숫자 없는 40자 AWS 시크릿이 통과했는데도 초록이었다.
 *
 * 지금 생성기는 각 유형의 **형태 규격**(접두사·길이·문자 클래스)만 지킨다.
 * 숫자 없는 키도, 대문자만인 40자도 생성된다. git SHA-1(순수 hex 40자)만 제외하는데,
 * 그건 구현의 좁힘이 아니라 **의도된 오탐 방지 대상**이라 표본에서 빼는 게 맞다.
 *
 * 단언도 `not.toContain(secret)`에서 **길이 8 이상 모든 연속 부분문자열 부재**로 바꿨다.
 * 완전 일치만 보면 "앞 12자만 보존" 같은 부분 유출을 통째로 놓친다(뮤테이션 생존 사례).
 *
 * 회피 변형(제로폭 삽입·전각 치환)도 생성한다. 원문에 정규식을 직접 돌리면
 * 이 두 변형이 마스킹을 100% 우회하는데, 플래그도 안 붙어서 조용히 저장된다.
 *
 * ## `numRuns`는 왜 300인가 — 올리지 마라, 실측으로 무의미하다
 *
 * "300회로는 반례를 놓치는 것 아닌가"를 실측했다. **결론: 올려도 아무것도 더 못 잡는다.**
 *
 * 1. **20,000회 × 22 프로퍼티(44만 케이스, 58초) → 반례 0건.** 300회와 검출 차이가 없다.
 *    (주의: `numRuns`를 올리면 vitest 기본 `testTimeout`(5초)에 걸려 **타임아웃이 실패로
 *    보인다.** 그건 반례가 아니다 — 반례라면 fast-check가 `Property failed after ...`와
 *    seed·counterexample을 찍는다. 올려서 돌릴 거면 `--testTimeout`도 같이 올려라.)
 * 2. **더 결정적인 것:** 실제 유출(N-14, ASCII 94자 중 93자가 새던 대역)을 코드에 되살려
 *    놓고 20,000회를 돌려도 **22개 전부 통과한다.** 같은 뮤턴트를 `sanitize.axes.spec.ts`는
 *    0.3초에 6건으로 잡는다.
 *
 * 이유는 표본 수가 아니라 **생성기의 모양**이다. 이 파일의 mongo 생성기는 호스트가 상수고
 * (`:450` 부근) `:`가 템플릿에 리터럴로 박혀 있으며 `mongoCredentialArb`의 알파벳이
 * `KEY_CHARS`(`[A-Za-z0-9_-]`)라, **N-13·N-14가 살던 축을 원리적으로 생성하지 못한다.**
 * 생성 못 하는 축은 44만 번을 뽑아도 안 나온다. 회차를 늘리는 것은 **같은 사각지대를 더 오래
 * 들여다보는 것**이고, CI 시간만 20배 쓴다.
 *
 * 그러므로 여기서 살 것은 회차가 아니라 **생성기의 폭**이다(문법 위치별 표집 — 포스트모템 §3.2).
 * 그 전까지 이 축의 실질 방어선은 `sanitize.axes.spec.ts`의 전수 스윕이다.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_INPUT_CHARS, SanitizeInputTooLargeError, sanitize } from "./sanitize.js";

const UPPER_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER_ALPHA = "abcdefghijklmnopqrstuvwxyz".split("");
const ALPHA = [...UPPER_ALPHA, ...LOWER_ALPHA];
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const BASE64ISH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".split("");
const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-".split("");
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");

function fixedLengthFrom(chars: readonly string[], length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...chars), { minLength: length, maxLength: length })
    .map((cs) => cs.join(""));
}

function variableLengthFrom(
  chars: readonly string[],
  minLength: number,
  maxLength: number,
): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...chars), { minLength, maxLength }).map((cs) => cs.join(""));
}

/** 명백한 자리표시자 표기(`xxx`, `***`, `...`)는 시크릿이 아니므로 표본에서 뺀다. */
const PLACEHOLDER_LITERAL_RE = /^[*x·.\-_]+$/i;

/** AWS 액세스 키 ID: AKIA|ASIA + 16자 대문자·숫자. */
const awsAccessKeyArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom("AKIA", "ASIA"), fixedLengthFrom(UPPER_ALNUM, 16))
  .map(([prefix, body]) => `${prefix}${body}`);

/**
 * AWS 시크릿 액세스 키: 40자 base64류. **문자 구성에 아무 조건도 걸지 않는다.**
 *
 * 문자 구성이 치우친 계열을 **명시적 분기로** 생성한다. 균등 랜덤 40자만 뽑으면
 * 숫자 없는 표본이 `(54/64)^40 ≈ 0.11%`로만 나와서 "숫자 1개 이상" 같은 잘못된
 * 좁힘 조건이 300회 실행을 그냥 통과한다(실제로 그 뮤턴트가 살아남았다).
 * 확률에 기대지 않고 계열을 직접 만들어야 B-4 회귀가 고정된다.
 *
 * 순수 hex 40자만 뺀다 — 그건 git SHA-1과 구별이 불가능해 의도적으로 통과시키는 값이다.
 */
const awsSecretKeyArb: fc.Arbitrary<string> = fc
  .oneof(
    fixedLengthFrom(BASE64ISH, 40), // 무제약
    fixedLengthFrom(ALPHA, 40), // 숫자 없음
    fixedLengthFrom(UPPER_ALPHA, 40), // 대문자만
    fixedLengthFrom(LOWER_ALPHA, 40), // 소문자만
    fixedLengthFrom(UPPER_ALNUM, 40), // 소문자 없음
  )
  .filter((s) => !/^[0-9a-f]{40}$/i.test(s));

/** 하한 근처(4자)부터의 Bearer 토큰. 자리표시자 표기만 제외한다. */
const bearerTokenArb: fc.Arbitrary<string> = variableLengthFrom(TOKEN_CHARS, 4, 64).filter(
  (t) => !PLACEHOLDER_LITERAL_RE.test(t),
);

/**
 * sk- / sk-ant- / pa- 계열 API 키. **숫자 포함 조건 없음** — 실제 발급 키가
 * 반드시 숫자를 포함한다는 근거가 없고, 그 가정이 B-3 미탐의 원인이었다.
 * AWS 시크릿과 같은 이유로 숫자 없는 본문을 명시적 분기로 생성한다.
 */
const apiKeyBodyArb: fc.Arbitrary<string> = fc.oneof(
  variableLengthFrom(KEY_CHARS, 24, 48),
  variableLengthFrom(ALPHA, 24, 48), // 숫자 없음
  variableLengthFrom(UPPER_ALPHA, 20, 30), // 대문자만
  variableLengthFrom(LOWER_ALPHA, 20, 30), // 소문자만
);

const apiKeyArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom("sk-", "sk-ant-", "pa-"), apiKeyBodyArb)
  .map(([prefix, body]) => `${prefix}${body}`);

/** mongodb URI의 사용자·비밀번호. 자리표시자로 오인될 여지가 없게 24자 이상. */
const mongoCredentialArb: fc.Arbitrary<string> = variableLengthFrom(KEY_CHARS, 24, 40);

// ---------------------------------------------------------------------------
// 회피 변형 생성기 (B-1 회귀 고정)
// ---------------------------------------------------------------------------

/**
 * ## 표집을 구현에서 독립시킨다 (T-004 결정 3 / F-17)
 *
 * 이 생성기는 두 번 실패했다. 처음에는 하드코딩 목록이라 형제 문자(`Me`·C0)를 만들지 못했고,
 * 고친 뒤에도 표집 조건이 `invisible.ts`의 구현 집합(`\p{M} | Default_Ignorable` + C0/C1)과
 * **글자 그대로 같아서** 구현이 모르는 `\p{Cf}` 29종(N-9)을 그대로 통과시켰다.
 * 목록을 유니코드 속성 표현으로 바꿨을 뿐 여전히 구현에서 역산돼 있었던 것이다.
 *
 * 그래서 여기서는 **구현이 무엇을 지우는지 보지 않고** 표집한다:
 *
 * 1. 유니코드 General_Category를 런타임 `\p{...}`로 직접 열거한다. `invisible.ts`를 import하지
 *    않으므로 구현이 범주를 빠뜨려도 표본은 줄어들지 않는다.
 * 2. 거기에 **전 평면 무작위 표집**을 섞는다. 범주 열거가 놓치는 축(예: `Lo`인데 빈칸으로
 *    렌더되는 U+2800 계열)이 있어도 이쪽이 잡는다.
 *
 * 기대값을 가르는 기준은 구현이 아니라 **렌더링**이다:
 *
 * - `Cc`·`Cf`·`Cs`·`Mn`·`Mc`·`Me`·`Default_Ignorable` → 자기 폭도 글리프도 없거나(서식·제어),
 *   앞 글자에 얹힌다(결합 표시). 시크릿 한가운데 끼워도 **사람 눈에는 시크릿이 그대로 보인다**
 *   → 반드시 마스킹돼야 한다.
 * - `Zs`·`Zl`·`Zp`(보이는 공백)·`Co`(사용자 정의 글리프)와 그 밖의 일반 문자 → 시크릿을
 *   **눈에 보이게 끊는다.** 일반 공백을 넣은 것과 같으므로 마스킹을 요구하지 않는다.
 *   대신 시크릿 **바깥**에 붙였을 때 마스킹을 깨뜨리지 않을 것을 요구한다.
 *
 * 이 분류는 구현 집합보다 넓다 — 실제로 `Cs`(짝 없는 서로게이트)에서 구현이 모르던
 * 미탐을 즉시 찾아냈다. 넓은 쪽이 옳다: 표본이 구현을 넘어야 구멍을 찾을 수 있다.
 */
function categoryRe(name: string): RegExp {
  return new RegExp(`^\\p{General_Category=${name}}$`, "u");
}

/** 폭도 글리프도 없는 범주 — 끼워 넣어도 시크릿이 그대로 읽힌다. */
const VANISHING_RE = new RegExp(
  [
    ...["Cc", "Cf", "Cs", "Mn", "Mc", "Me"].map((name) => `\\p{General_Category=${name}}`),
    "\\p{Default_Ignorable_Code_Point}",
  ].join("|"),
  "u",
);

/** 자리를 차지하거나 글리프를 갖는 범주 — 시크릿을 눈에 보이게 끊는다. */
const SEPARATING_CATEGORIES = ["Co", "Zs", "Zl", "Zp"] as const;

/** 열거 대상 범주 전체. 표집을 여기서만 정하고 구현은 보지 않는다. */
const SAMPLED_CATEGORIES = ["Cc", "Cf", "Cs", "Mn", "Mc", "Me", ...SEPARATING_CATEGORIES] as const;

/** 열거 스윕에서 후보를 빠르게 거르는 합집합. 미할당 코드포인트가 대부분이라 이 한 번으로 끝난다. */
const SEPARATOR_HINT_RE = new RegExp(
  SEPARATING_CATEGORIES.map((name) => `\\p{General_Category=${name}}`).join("|"),
  "u",
);

/**
 * NFKD 정규화 후 ASCII 단어 문자가 되는지. 전각 `Ａ`·수학 알파벳 `𝐀`·원문자 `①`이 여기 걸린다.
 * 이런 문자를 시크릿 옆에 붙이면 토큰 자체가 달라지므로 마스킹을 요구할 수 없다 —
 * 구현의 좁힘을 베낀 것이 아니라 "글자를 덧붙였다"는 사실에서 나오는 제외다.
 */
function normalizesToWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char.normalize("NFKD"));
}

/** 구조를 나르는 공백과 일반 공백은 제외한다 — 지워지지 않는 것이 정상이다. */
function isStructuralSpace(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20;
}

/** 코드포인트를 표본 두 통 중 하나에 넣는다. 어디에도 안 맞으면 버린다. */
function classify(codePoint: number, vanishing: string[], separating: string[]): void {
  if (isStructuralSpace(codePoint)) return;
  const char = String.fromCodePoint(codePoint);
  if (VANISHING_RE.test(char)) {
    vanishing.push(char);
    return;
  }
  if (normalizesToWordChar(char)) return;
  separating.push(char);
}

/** 범주별 표본 수를 맞춘다. 앞에서 N개를 자르면 한 블록에 쏠려 형제 문자를 못 만든다. */
function spread<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

const PER_CATEGORY_LIMIT = 64;
const PER_CATEGORY_SWEEP_CAP = 4096;

/**
 * General_Category 열거. 전 평면을 한 번 훑고 범주별로 나눠 담는다.
 * 범주마다 **같은 수**를 뽑아 큰 범주(`Mn`·`Cs`·`Co`)가 표본을 잠식하지 않게 한다 —
 * `Cf`는 170여 자뿐이라 비율로 뽑으면 N-9 29종이 표본에서 사실상 사라진다.
 */
function sampleByCategory(): { vanishing: string[]; separating: string[] } {
  const testers = SAMPLED_CATEGORIES.map((name) => ({ name, re: categoryRe(name) }));
  const buckets = new Map<string, number[]>(SAMPLED_CATEGORIES.map((name) => [name, []]));

  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const char = String.fromCodePoint(cp);
    if (!VANISHING_RE.test(char) && !SEPARATOR_HINT_RE.test(char)) continue;
    for (const { name, re } of testers) {
      const bucket = buckets.get(name);
      if (bucket === undefined || bucket.length >= PER_CATEGORY_SWEEP_CAP) continue;
      if (re.test(char)) {
        bucket.push(cp);
        break;
      }
    }
  }

  const vanishing: string[] = [];
  const separating: string[] = [];
  for (const found of buckets.values()) {
    for (const cp of spread(found, PER_CATEGORY_LIMIT)) classify(cp, vanishing, separating);
  }
  return { vanishing, separating };
}

/**
 * 전 평면(BMP + astral) 균등 표집. 결정론을 위해 고정 시드 LCG를 쓴다 —
 * 실행마다 표본이 달라지면 실패가 재현되지 않는다.
 */
function sampleAllPlanes(count: number): { vanishing: string[]; separating: string[] } {
  const vanishing: string[] = [];
  const separating: string[] = [];
  let state = 0x5f3a_c91d;
  for (let i = 0; i < count; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    classify(state % 0x110000, vanishing, separating);
  }
  return { vanishing, separating };
}

const BY_CATEGORY = sampleByCategory();
const ALL_PLANES = sampleAllPlanes(600);

/** 시크릿 안에 끼워도 시크릿이 그대로 읽히는 문자 — 마스킹이 유일한 방어선이다. */
const INVISIBLE_CHARS = [...BY_CATEGORY.vanishing, ...ALL_PLANES.vanishing];

/** 시크릿을 눈에 보이게 끊는 문자 — 바깥에 붙어도 마스킹을 깨면 안 된다. */
const SEPARATING_CHARS = [...BY_CATEGORY.separating, ...ALL_PLANES.separating];

/**
 * 시크릿 중간 임의 위치에 제로폭 문자 하나를 끼운다.
 * **하나만** 넣는 것이 핵심이다 — 인젝션 임계값(3) 이하라 `injection-suspect`도 안 붙는다.
 * 즉 이 변형은 플래그로도 잡히지 않는, 순수한 마스킹 우회다.
 */
function insertZeroWidth(secret: string): fc.Arbitrary<string> {
  // 위치 범위가 `0 ~ length` 여야 한다. 내부(1 ~ length-1)만 만들면 **경계 우회를
  // 원리적으로 생성하지 못한다** — 실제로 그 갭 때문에 N-1이 프로퍼티를 통과했다.
  // 경계에 낀 비가시 문자는 옆 토큰을 시크릿에 붙여 앵커를 깨는, 내부 삽입과 다른 실패 모드다.
  return fc
    .tuple(fc.integer({ min: 0, max: secret.length }), fc.constantFrom(...INVISIBLE_CHARS))
    .map(([position, zw]) => `${secret.slice(0, position)}${zw}${secret.slice(position)}`);
}

/**
 * 시크릿 **바깥** 바로 옆에 비가시 문자를 두고 영숫자를 붙인다.
 * `AKIA...EXAMPLE<ZWSP>x` — 프로브에서 `...EXAMPLEx`가 되어 어떤 규칙에도 안 걸리던 형태다.
 */
function glueNeighbour(secret: string): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...INVISIBLE_CHARS), fc.constantFrom("x", "q", "7"), fc.boolean())
    .map(([zw, neighbour, atEnd]) =>
      atEnd ? `${secret}${zw}${neighbour}` : `${neighbour}${zw}${secret}`,
    );
}

/** ASCII 가시 문자를 전각으로 바꾼다. NFKC로 되돌아오므로 정규화 좌표계에서는 같은 값이다. */
function toFullWidth(char: string): string {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return char;
  return codePoint >= 0x21 && codePoint <= 0x7e ? String.fromCodePoint(codePoint + 0xfee0) : char;
}

/** 시크릿의 일부(또는 전부) 문자를 전각으로 바꾼다. `ＡＫＩＡIOSFODNN7EXAMPLE` 형태. */
function toPartialFullWidth(secret: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: secret.length, maxLength: secret.length })
    .map((flips) =>
      [...secret].map((char, i) => (flips[i] === true ? toFullWidth(char) : char)).join(""),
    );
}

/** 원문 그대로 + 제로폭 삽입 + 전각 치환. 세 변형 모두에서 마스킹돼야 한다. */
function evasionsOf(secret: string): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(secret),
    insertZeroWidth(secret),
    glueNeighbour(secret),
    toPartialFullWidth(secret),
  );
}

// ---------------------------------------------------------------------------
// 단언
// ---------------------------------------------------------------------------

const FRAGMENT_WINDOW = 8;

/**
 * 시크릿의 **길이 8 이상 모든 연속 부분문자열**이 결과에 없는지 확인한다.
 * `not.toContain(secret)`은 "앞 12자만 남기고 마스킹" 같은 부분 유출을 통과시킨다 —
 * 실제로 그 뮤턴트가 살아남았다. 8자는 임의의 선이 아니라 "이 조각만으로 원본을
 * 특정하거나 무차별 대입 범위를 실용적으로 좁힐 수 있는" 최소 길이로 잡은 것이다.
 */
function expectNoSecretFragment(output: string, secret: string): void {
  if (secret.length < FRAGMENT_WINDOW) {
    expect(output).not.toContain(secret);
    return;
  }
  for (let i = 0; i + FRAGMENT_WINDOW <= secret.length; i += 1) {
    expect(output).not.toContain(secret.slice(i, i + FRAGMENT_WINDOW));
  }
}

/** 시크릿을 감싸는 임의의 산문. 한국어·영어·기호가 섞여도 결과가 같아야 한다. */
const contextArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.string({ maxLength: 40 }),
  fc.constantFrom(
    "재현 로그:",
    "worker가 죽기 직전 남긴 값",
    "환경변수 덤프\n",
    "curl -H 'Authorization:",
    "— 이 값이 그대로 슬랙에 올라갔다.",
  ),
);

/** 시크릿을 랜덤 문맥 사이에 공백으로 분리해 심는다. */
function embed(prefix: string, secret: string, suffix: string): string {
  return `${prefix} ${secret} ${suffix}`;
}

const SECRET_ARBS: readonly [name: string, arb: fc.Arbitrary<string>][] = [
  ["aws-access-key", awsAccessKeyArb],
  ["aws-secret-key", awsSecretKeyArb],
  ["api-key", apiKeyArb],
];

describe("sanitize — 프로퍼티: 원문 시크릿은 조각도 남지 않는다 (T-004 Acceptance 3)", () => {
  it.each(SECRET_ARBS)("%s 는 어떤 문맥에서도 사라진다", (_name, arb) => {
    fc.assert(
      fc.property(contextArb, arb, contextArb, (prefix, secret, suffix) => {
        const { text, flags } = sanitize(embed(prefix, secret, suffix), { maskEmail: false });

        expectNoSecretFragment(text, secret);
        expect(flags).toContain("secret-masked");
      }),
      { numRuns: 300 },
    );
  });

  it.each(SECRET_ARBS)(
    "%s 는 제로폭 삽입·전각 치환으로 회피할 수 없다",
    (_name, arb) => {
      fc.assert(
        fc.property(
          contextArb,
          arb.chain((secret) => fc.tuple(fc.constant(secret), evasionsOf(secret))),
          contextArb,
          (prefix, [secret, evaded], suffix) => {
            const { text, flags } = sanitize(embed(prefix, evaded, suffix), { maskEmail: false });

            // 원문 시크릿과 회피 변형 **양쪽**의 조각이 모두 없어야 한다.
            expectNoSecretFragment(text, secret);
            expectNoSecretFragment(text, evaded);
            expect(flags).toContain("secret-masked");
          },
        ),
        { numRuns: 300 },
      );
    },
  );

  it("Bearer 토큰은 어떤 문맥에서도 사라진다", () => {
    fc.assert(
      fc.property(contextArb, bearerTokenArb, contextArb, (prefix, token, suffix) => {
        const { text, flags } = sanitize(embed(prefix, `Bearer ${token}`, suffix), {
          maskEmail: false,
        });

        expectNoSecretFragment(text, token);
        expect(flags).toContain("secret-masked");
      }),
      { numRuns: 300 },
    );
  });

  it("Bearer 토큰은 제로폭 삽입·전각 치환으로 회피할 수 없다", () => {
    fc.assert(
      fc.property(
        bearerTokenArb.chain((token) => fc.tuple(fc.constant(token), evasionsOf(token))),
        ([token, evaded]) => {
          const { text, flags } = sanitize(`Authorization: Bearer ${evaded}`, {
            maskEmail: false,
          });

          expectNoSecretFragment(text, token);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * 꺾쇠로 감싼 토큰. `Bearer <eyJhbGci...>`는 문서 표기처럼 보이지만 안에 실제 JWT가 든다.
   *
   * 표본에서 **명백한 자리표시자 모양**(꺾쇠 안이 20자 미만이고 영문자·공백·하이픈·
   * 언더스코어뿐)은 뺀다. `<token>`·`<user>`는 값이 아니라 표기이고, 이건 구현의 좁힘을
   * 복사한 게 아니라 git SHA-1 제외와 같은 **의도된 오탐 방지 대상**이다.
   */
  const angleWrappableTokenArb = bearerTokenArb.filter(
    (token) => token.length >= 20 || /[^A-Za-z _-]/.test(token),
  );

  it("꺾쇠로 감싼 Bearer 토큰도 회피 수단이 되지 않는다", () => {
    fc.assert(
      fc.property(
        angleWrappableTokenArb.chain((token) => fc.tuple(fc.constant(token), evasionsOf(token))),
        ([token, evaded]) => {
          const { text, flags } = sanitize(`Authorization: Bearer <${evaded}>`, {
            maskEmail: false,
          });

          expectNoSecretFragment(text, token);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("mongodb URI의 사용자·비밀번호는 사라지고 호스트는 남는다", () => {
    fc.assert(
      fc.property(mongoCredentialArb, mongoCredentialArb, (user, pass) => {
        const host = "cluster0.ab12c.mongodb.net";
        const { text, flags } = sanitize(`mongodb+srv://${user}:${pass}@${host}/sentinel`, {
          maskEmail: false,
        });

        expectNoSecretFragment(text, user);
        expectNoSecretFragment(text, pass);
        expect(text).toContain(host);
        expect(flags).toContain("secret-masked");
      }),
      { numRuns: 300 },
    );
  });

  /**
   * 문서 템플릿에 비밀번호만 채워 붙여넣은 형태. 트러블슈팅 기록에서 가장 흔한 유출이다.
   * 사용자 쪽이 자리표시자라고 비밀번호까지 통과시키면 그 값이 그대로 영구 저장된다.
   */
  it("사용자가 자리표시자여도 실제 비밀번호는 사라진다", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("<user>", "<username>", "<db-user>", "xxx", "***"),
        mongoCredentialArb,
        (userPlaceholder, pass) => {
          const { text, flags } = sanitize(
            `mongodb+srv://${userPlaceholder}:${pass}@cluster0.example.net/db`,
            { maskEmail: false },
          );

          expectNoSecretFragment(text, pass);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 200 },
    );
  });

  /** `${...}`는 셸 보간 표기일 뿐, 그 자리에 실제 값이 없다는 보장이 아니다. */
  it("셸 보간·꺾쇠로 감싼 비밀번호도 사라진다", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("${VALUE}", "<VALUE>", "'VALUE'", '"VALUE"'),
        mongoCredentialArb,
        (wrapper, pass) => {
          const wrapped = wrapper.replace("VALUE", pass);
          const { text, flags } = sanitize(
            `mongodb+srv://svcuser:${wrapped}@cluster0.example.net/db`,
            { maskEmail: false },
          );

          expectNoSecretFragment(text, pass);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 200 },
    );
  });

  /** 앵커가 붙으면 값의 모양을 따지지 않는다 — AWS 시크릿 규칙과 같은 대칭. */
  it("API 키 앵커가 붙은 값은 모양과 무관하게 사라진다", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "ANTHROPIC_API_KEY=",
          "OPENAI_API_KEY=",
          "VOYAGE_API_KEY=",
          "API_KEY=",
          "api_key: ",
          "apiKey: ",
        ),
        variableLengthFrom(KEY_CHARS, 8, 60),
        (anchor, value) => {
          const { text, flags } = sanitize(`${anchor}${value}`, { maskEmail: false });

          expectNoSecretFragment(text, value);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * 앵커 규칙이 값의 **끝까지** 삼키는지. 40자에서 끊으면 41자 값의 마지막 글자가
   * `[MASKED:aws-secret-key]Z` 처럼 평문으로 남는다. 길이 하한을 48로 잡아
   * 잔여물이 항상 8자 이상이 되게 했다 — 그래야 조각 단언이 잔여물을 실제로 본다.
   * 정확히 1글자만 남는 경계 사례는 유닛 테스트가 완전 일치로 따로 잠근다.
   */
  it("앵커가 붙은 AWS 시크릿은 값의 끝까지 사라진다", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "aws_secret_access_key=",
          "AWS_SECRET_ACCESS_KEY=",
          "secret_access_key: ",
          'aws-secret-access-key="',
        ),
        variableLengthFrom(BASE64ISH, 48, 80),
        (anchor, value) => {
          const { text, flags } = sanitize(`${anchor}${value}`, { maskEmail: false });

          expectNoSecretFragment(text, value);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * 표본의 나머지 절반 — 시크릿을 **눈에 보이게 끊는** 문자(보이는 공백·사용자 정의 글리프·
   * 그 밖의 일반 문자)다. 이쪽에는 마스킹을 요구할 수 없다. 일반 공백을 끼운 것과 같아서
   * 사람이 봐도 시크릿이 끊겨 보이기 때문이다. 대신 **바깥에 붙었을 때 마스킹을 깨지 않을 것**을
   * 요구한다 — 경계 문자가 앵커를 무너뜨리는 실패 모드(N-1)는 가시 문자에서도 성립한다.
   *
   * AWS 액세스 키로만 확인한다. 40자 base64 규칙은 단어 경계가 아니라 문자 클래스 경계를 쓰므로
   * base64 알파벳에 속한 구분자(`/`·`+`·`=`)가 붙으면 **정말로 다른 런**이 되어 마스킹하지 않는
   * 것이 옳다 — 그건 회피가 아니라 값이 달라진 것이다.
   */
  it("시크릿을 끊는 가시 문자가 바깥에 붙어도 마스킹은 깨지지 않는다", () => {
    fc.assert(
      fc.property(
        awsAccessKeyArb,
        fc.constantFrom(...SEPARATING_CHARS),
        fc.constantFrom("x", "q", "7"),
        fc.boolean(),
        (secret, separator, neighbour, atEnd) => {
          const input = atEnd
            ? `${secret}${separator}${neighbour}`
            : `${neighbour}${separator}${secret}`;
          const { text, flags } = sanitize(input, { maskEmail: false });

          expectNoSecretFragment(text, secret);
          expect(flags).toContain("secret-masked");
        },
      ),
      { numRuns: 400 },
    );
  });

  it("여러 유형이 한 텍스트에 섞여도 전부 사라진다", () => {
    fc.assert(
      fc.property(
        awsAccessKeyArb,
        awsSecretKeyArb,
        apiKeyArb,
        bearerTokenArb,
        (accessKey, secretKey, apiKey, token) => {
          const input = [accessKey, secretKey, apiKey, `Bearer ${token}`].join("\n");
          const { text } = sanitize(input, { maskEmail: false });

          for (const secret of [accessKey, secretKey, apiKey, token]) {
            expectNoSecretFragment(text, secret);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("sanitize — 프로퍼티: 불변식", () => {
  it("결정론 — 같은 입력은 항상 같은 출력을 낸다", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        expect(sanitize(input, { maskEmail: false })).toEqual(
          sanitize(input, { maskEmail: false }),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("멱등 — 마스킹된 결과를 다시 새니타이즈해도 본문이 변하지 않는다", () => {
    fc.assert(
      fc.property(contextArb, awsSecretKeyArb, contextArb, (prefix, secret, suffix) => {
        const once = sanitize(embed(prefix, secret, suffix), { maskEmail: false }).text;

        expect(sanitize(once, { maskEmail: false }).text).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it("사설 IP는 어떤 옥텟 조합에서도 마스킹되지 않는다", () => {
    const privateIpArb = fc.oneof(
      fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
    );

    fc.assert(
      fc.property(privateIpArb, (octets) => {
        const ip = octets.join(".");
        const input = `${ip} 에서 온 요청만 통과했다.`;

        expect(sanitize(input, { maskEmail: false })).toEqual({
          text: input,
          flags: [],
          masked: [],
          injectionRules: [],
        });
      }),
      { numRuns: 300 },
    );
  });

  /** git SHA-1은 매 문단 등장한다. 40자 hex는 어떤 조합에서도 보존돼야 한다. */
  it("git SHA-1(40자 hex)은 어떤 조합에서도 마스킹되지 않는다", () => {
    const shaArb = fixedLengthFrom("0123456789abcdef".split(""), 40);

    fc.assert(
      fc.property(shaArb, (sha) => {
        const input = `커밋 ${sha} 에서 회귀가 시작됐다.`;

        expect(sanitize(input, { maskEmail: false })).toEqual({
          text: input,
          flags: [],
          masked: [],
          injectionRules: [],
        });
      }),
      { numRuns: 300 },
    );
  });

  /**
   * ReDoS·이차곡선 회귀 고정. 이메일 규칙의 로컬파트가 무한 반복이면 12초짜리 동기 블록이
   * 생기고, 겹침 해소가 세그먼트 수에 이차면 `Bearer ` 런이 초 단위로 튄다(T-004 F-11/F-14).
   * 둘 다 저장 경로의 **동기** 게이트에서 API를 통째로 멈춘다.
   *
   * 크기는 상한(`DEFAULT_MAX_INPUT_CHARS`)에 맞춘다 — 그보다 큰 입력은 이제 애초에 거절되므로
   * 최악의 통과 가능 입력이 곧 이 크기다. `Bearer ` 런은 7바이트마다 세그먼트를 만드는,
   * 실측으로 확인된 최악의 모양이다.
   *
   * 겹침 해소의 이차 곡선은 알고리즘이 아니라 이 상한으로 막는다 — 상한 안에서는 최악이
   * 58ms다. 상한 500ms는 CI 머신 편차를 흡수하려는 값이지 성능 목표가 아니다.
   *
   * ## 워밍 후 최소값을 재는 이유 (간헐 실패 수정)
   *
   * 단발·콜드 측정은 `pnpm verify` 전체 실행에서 **20여 번에 한 번 거짓 실패**했다.
   * 실측: `expected 635.4125000000004 to be less than 500`.
   * 원인은 코드가 아니라 **계기**다. 두 가지가 겹쳤다:
   *
   * 1. **JIT 컴파일이 측정에 섞였다.** `Bearer ` 런 연속 8회 실측:
   *    `179, 163, 60, 57, 57, 55, 56, 57 ms` — 처음 두 번이 3배다.
   *    바로 위 문단의 **"최악 58ms"가 정상상태 수치**이고, 이 테스트가 지키려는 불변식
   *    (겹침 해소가 이차가 아니다)도 정상상태의 성질이다. 콜드를 재면 알고리즘 비용이 아니라
   *    **컴파일 비용**을 재게 된다.
   * 2. **병렬 실행의 CPU 경쟁.** vitest가 파일을 병렬로 돌리므로 다른 워커와 코어를 다툰다.
   *
   * 그래서 입력마다 **워밍 2회 후 3회 중 최소**를 취한다. 임계값은 **그대로 500ms**다.
   * 정상상태 57ms 대비 8.8배 여유라, 부하가 섞여도 흔들리지 않는다(콜드 단발은 2.7배였다).
   *
   * **기대값을 낮춘 것이 아니라 재는 대상을 정확히 한 것이다** — 이차 곡선 회귀가 나면
   * 워밍 후에도 세 번 다 느리므로 최소값이 임계를 넘는다. 잡으려는 것(F-11/F-14)은 그대로 잡힌다.
   *
   * 거짓 실패를 남겨 두는 쪽이 더 나쁘다. 20번에 한 번 우는 경보기는 사람들이 재실행으로
   * 넘기는 법을 배우게 만들고, 그러면 **진짜 실패도 같이 넘어간다.**
   */
  it("상한 크기 입력을 이메일 마스킹까지 켜고 선형 시간에 처리한다", () => {
    const size = DEFAULT_MAX_INPUT_CHARS;
    const inputs = [
      "Bearer ".repeat(Math.ceil(size / 7)).slice(0, size),
      "a.b_c-d%e+f".repeat(Math.ceil(size / 11)).slice(0, size),
      `${"x".repeat(size / 2)}@${"y".repeat(200)} ${"aB3/+=".repeat(8000)}`.slice(0, size),
      "0123456789abcdef".repeat(size / 16),
    ];

    for (const input of inputs) {
      // 워밍 — 재려는 것은 정상상태 알고리즘 비용이지 JIT 컴파일 비용이 아니다.
      sanitize(input, { maskEmail: true });
      sanitize(input, { maskEmail: true });

      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startedAt = performance.now();
        sanitize(input, { maskEmail: true });
        best = Math.min(best, performance.now() - startedAt);
      }

      expect(best).toBeLessThan(500);
    }
  });

  /**
   * 상한을 넘긴 입력은 **자르지 않고 던진다.** 조용히 자르면 잘려나간 부분의 시크릿을
   * 검사하지 않은 채 호출자가 그 사실을 모르고 저장한다 (T-004 결정 4).
   */
  it("상한을 넘긴 입력은 어떤 내용이든 SanitizeInputTooLargeError로 거절한다", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.string({ maxLength: 8 }), (over, filler) => {
        const unit = filler === "" ? "x" : filler;
        const input = unit.repeat(Math.ceil((DEFAULT_MAX_INPUT_CHARS + over) / unit.length));

        expect(() => sanitize(input, { maskEmail: false })).toThrow(SanitizeInputTooLargeError);
      }),
      { numRuns: 50 },
    );
  });
});
