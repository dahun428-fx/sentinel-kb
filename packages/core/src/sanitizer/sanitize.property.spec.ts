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
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sanitize } from "./sanitize.js";

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

const INVISIBLE_PROBE_RE = /\p{M}|\p{Default_Ignorable_Code_Point}/u;

/**
 * 비가시 문자 표본을 **유니코드 속성에서 직접 뽑는다.**
 *
 * 하드코딩 목록을 쓰면 안 되는 이유가 T-004에서 세 번 증명됐다 — 목록은 언제나
 * "코드가 이미 처리하는 것"에서 역산되므로 형제 문자를 원리적으로 생성하지 못한다.
 * Me 결합 표시(N-6)와 C0 제어문자(N-7)가 정확히 그렇게 프로퍼티를 통과했다.
 * 여기서는 코드가 무엇을 지우는지와 **무관하게** 속성으로 표집하므로,
 * 다음번에 또 어떤 범주를 빠뜨리면 이 생성기가 먼저 잡는다.
 */
function sampleInvisibleChars(): string[] {
  const found: string[] = [];
  const isTarget = (cp: number): boolean => {
    // 구조를 나르는 공백은 제외한다 — 지워지지 않는 것이 정상이다.
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
    return INVISIBLE_PROBE_RE.test(String.fromCodePoint(cp));
  };
  // BMP 전체 + tag/variation-selector 보충면. 매 8번째만 표집해 목록을 적당히 유지한다.
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // 서로게이트 단독은 문자가 아니다
    if (cp % 8 === 0 && isTarget(cp)) found.push(String.fromCodePoint(cp));
  }
  for (let cp = 0xe0000; cp <= 0xe01ff; cp += 16) {
    if (isTarget(cp)) found.push(String.fromCodePoint(cp));
  }
  return found;
}

const INVISIBLE_CHARS = sampleInvisibleChars();

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

        expect(sanitize(input, { maskEmail: false })).toEqual({ text: input, flags: [] });
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

        expect(sanitize(input, { maskEmail: false })).toEqual({ text: input, flags: [] });
      }),
      { numRuns: 300 },
    );
  });

  /**
   * ReDoS 회귀 고정. 이메일 규칙의 로컬파트가 무한 반복이면 100KB 입력에서
   * 12초짜리 동기 블록이 생긴다 — `SANITIZE_MASK_EMAIL=true`인 순간 저장 API가 멈춘다.
   * 여유를 크게 잡은 상한이다(실측은 100ms를 한참 밑돈다). CI 머신 편차를 흡수하려는 것이지
   * 이 값이 성능 목표라는 뜻이 아니다.
   */
  it("100KB 입력을 이메일 마스킹까지 켜고 선형 시간에 처리한다", () => {
    const inputs = [
      "a.b_c-d%e+f".repeat(9100).slice(0, 100_000),
      `${"x".repeat(50_000)}@${"y".repeat(200)} ${"aB3/+=".repeat(8000)}`.slice(0, 100_000),
      "0123456789abcdef".repeat(6250),
    ];

    for (const input of inputs) {
      const startedAt = performance.now();
      sanitize(input, { maskEmail: true });

      expect(performance.now() - startedAt).toBeLessThan(1000);
    }
  });
});
