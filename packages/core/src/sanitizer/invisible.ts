/**
 * 비가시 문자 집합의 단일 소스.
 *
 * 마스킹(`masking.ts`)과 인젝션 탐지(`injection.ts`)가 각각 제로폭 상수를 들고 있으면
 * 한쪽만 넓혔을 때 조용히 갈라진다 — 실제로 그 갈림길에서 미탐이 났다(T-004 F-8/F-9).
 * 그래서 두 집합을 **여기 나란히** 두고 왜 다른지 근거를 남긴다.
 */

/**
 * 렌더링에서 무시되도록 정의된 문자 전체 (Unicode `Default_Ignorable_Code_Point`).
 * ZWSP·ZWNJ·ZWJ·WORD JOINER·BOM뿐 아니라 **soft hyphen(U+00AD), CGJ(U+034F),
 * variation selector(U+FE00–FE0F), tag 문자(U+E0000–E007F)** 까지 덮는다.
 *
 * 마스킹 프로브는 이 집합을 쓴다. 시크릿 사이에 이런 문자가 하나만 끼어도
 * 정규식이 빗나가고, 개수가 적으면 인젝션 플래그도 안 붙어 **플래그도 마스킹도 없이 통과**한다.
 * soft hyphen은 완전히 보이지 않고 PDF·웹 복사로 흔히 섞이므로 공격자가 아니어도 발생한다.
 *
 * 한글·한자와 정상 결합 악센트(U+0301 등)는 이 속성에 해당하지 않아 영향을 받지 않는다.
 * 프로브는 **매칭 전용 사본**이므로 여기서 무엇을 지우든 저장되는 원문은 그대로다.
 */
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * `Default_Ignorable`이 아니면서 **빈칸으로 렌더되는** 문자들.
 *
 * U+2800 BRAILLE PATTERN BLANK가 대표적이다 — 점자 블록이지만 점이 하나도 없어
 * 화면에는 공백으로 보인다. Unicode 속성상 `Lo`(기타 문자)라 `Default_Ignorable`에
 * 잡히지 않으므로 별도로 열거해야 한다. 한글 채움 문자도 같은 계열이다. (T-004 N-2)
 */
const BLANK_RENDERING_RE = /[⠀ᅠㅤﾠ]/u;

/**
 * 제어문자. C0(U+0000–U+001F) 중 구조를 나르는 `\t`·`\n`·`\r`은 **남기고**,
 * 나머지와 DEL(U+007F)·C1(U+0080–U+009F)·U+FFF9–FFFB를 지운다.
 *
 * `normalizeWithMap`이 성능을 위해 인쇄 가능 ASCII를 지름길로 통과시키는데, 제어문자까지
 * 함께 통과시키면 **프로브와 원문 양쪽에 남아 두 패스를 동시에 깬다**(T-004 N-7).
 * HTML 렌더에서는 결합 악센트보다 더 안 보인다.
 * `\n`을 남기는 이유는 mongo 규칙이 `[^:/@\n]`으로 줄 경계를 쓰기 때문이다 — 지우면 경계가 무너진다.
 */
function isControl(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  // 탭·개행·캐리지리턴은 구조를 나른다. 지우면 mongo 규칙의 줄 경계가 무너진다.
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  if (codePoint <= 0x1f) return true;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  return codePoint >= 0xfff9 && codePoint <= 0xfffb;
}

/**
 * 결합 표시 **전체**(`Mn` 비간격 + `Mc` 간격 + `Me` 둘러싸기).
 * `A` + U+0301 처럼 앞 글자에 얹히는 문자들이다.
 *
 * `Mn`만 지우면 안 된다 — `\p{Me}`(U+20E0, U+0488, U+A670 등)는 결합 표시인데 `Mn`이 아니고
 * NFKD도 지우지 않아 **완전히 같은 축의 우회가 그대로 열린다**(T-004 N-6).
 * 실제로 `AKIA` + U+20E0 + `IOSFODNN7EXAMPLE`이 플래그도 마스킹도 없이 전문 통과했다.
 * 3범주를 다 덮는 `\p{M}` 하나면 닫힌다.
 *
 * `Mc`까지 포함돼 데바나가리 모음기호 등이 프로브에서 사라지지만, 프로브는 **매칭 전용 사본**이고
 * 마스킹 규칙의 문자 클래스가 전부 ASCII라 없는 매치를 만들어낼 위험은 없다.
 *
 * 프로브는 NFKD로 분해한 뒤 이것들을 지운다. `AKIÁIOSFODNN7EXAMPLE`처럼 악센트 하나로
 * 정규식을 빗나가게 하는 우회를 막기 위함이다. 선조합(`Á` = U+00C1)과 조합형
 * (`A`+U+0301) 양쪽을 같은 방법으로 처리하려면 NFKC가 아니라 **NFKD**여야 한다 —
 * NFKC는 다시 합성해 버려 표시가 사라지지 않는다. (T-004 N-4)
 *
 * 프로브는 매칭 전용 사본이므로 여기서 무엇을 지우든 저장되는 원문은 그대로다.
 */
const COMBINING_MARK_RE = /\p{M}/u;

/**
 * 마스킹 프로브에서 제거할 문자 전체.
 * 위 세 집합의 합집합이며, 이것이 "보이지 않거나 폭을 차지하지 않는 것"의 실무적 정의다.
 */
export const IGNORABLE_RE = new RegExp(
  [
    DEFAULT_IGNORABLE_RE.source,
    BLANK_RENDERING_RE.source,
    COMBINING_MARK_RE.source,
  ].join("|"),
  "u",
);

/**
 * 인젝션 탐지의 "과도한 제로폭" 계수 대상 — 의도적 난독화에만 쓰이는 **진짜 폭 없는** 문자로 좁힌다.
 *
 * `IGNORABLE_RE`를 그대로 쓰지 않는 이유: variation selector U+FE0F가 **이모지 표현 선택자**라
 * 이모지 4개가 든 정상 기록이 `injection-suspect`로 오탐된다. soft hyphen도 PDF 복사본에
 * 정상적으로 여럿 들어온다. 인젝션 플래그는 지식을 지우지 않지만 검색 노출과 생성 컨텍스트
 * 제외에 영향을 주므로(specs/03 §2) 이쪽은 좁게 유지한다.
 *
 * 마스킹은 반대 방향이다 — 미탐이 유출이므로 넓게 잡는다.
 */
export const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;


/** 마스킹 프로브에서 이 문자를 만나면 프로브에 넣지 않는다. */
export function isIgnorable(char: string): boolean {
  return IGNORABLE_RE.test(char) || isControl(char);
}

/** 프로브용. 위 판정에 걸리는 문자를 전부 제거한다. */
export function stripInvisible(text: string): string {
  let out = "";
  for (const char of text) {
    if (!isIgnorable(char)) out += char;
  }
  return out;
}
