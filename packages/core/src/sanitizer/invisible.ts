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
 * 서식 문자(`Cf`) **전체**. `Default_Ignorable`과 겹치지만 같지 않다 —
 * `Cf`이면서 `Default_Ignorable`이 **아닌** 29종이 있고, 그 전부가 한때 플래그도 마스킹도 없이
 * 통과했다(T-004 N-9): U+0600–0605·U+06DD·U+070F·U+0890·U+0891·U+08E2(아랍 문자 앞에 붙는
 * prepended concatenation mark), U+110BD·U+110CD(카이티), U+13430–1343F(이집트 상형문자 서식 제어).
 * 이들은 앞 글자에 얹히거나 다음 글자와 결합해 **자기 폭을 갖지 않으므로** 시크릿 한가운데
 * 끼워 넣어도 사람 눈에는 시크릿이 그대로 보인다.
 *
 * `Default_Ignorable`만 보던 시절 U+FFF9–FFFB 세 개만 하드코딩으로 알고 있었다 —
 * 그것들도 `Cf`다. 범주 전체를 덮으면 열거가 필요 없어지고 형제 문자가 더 나오지 않는다.
 */
const FORMAT_RE = /\p{Cf}/u;

/**
 * 제어문자(`Cc`) 전체 — C0(U+0000–U+001F) + DEL·C1(U+007F–U+009F).
 * 구조를 나르는 `\t`·`\n`·`\r`만 `isIgnorable`이 따로 되살린다.
 *
 * `normalizeWithMap`이 성능을 위해 인쇄 가능 ASCII를 지름길로 통과시키는데, 제어문자까지
 * 함께 통과시키면 **프로브와 원문 양쪽에 남아 두 패스를 동시에 깬다**(T-004 N-7).
 * HTML 렌더에서는 결합 악센트보다 더 안 보인다.
 */
const CONTROL_RE = /\p{Cc}/u;

/**
 * 짝 없는 서로게이트(`Cs`). 올바른 텍스트에는 **원리적으로 등장하지 않는** 값이라
 * 렌더러가 U+FFFD로 바꾸거나 통째로 버린다 — 즉 폭 없는 삽입과 같은 효과다.
 * 실측으로 `AKIA\uD800IOSFODNN7EXAMPLE`이 플래그도 마스킹도 없이 통과했다.
 *
 * 정상적인 astral 문자는 서로게이트 **쌍**이고 `/u` 정규식은 그걸 코드포인트 하나로 보므로
 * `\p{Cs}`에 걸리지 않는다(😀 = U+1F600은 `So`). 즉 이 항목이 지우는 것은 깨진 입력뿐이다.
 *
 * 결정 2는 `Cf`·`Cc`만 지목했지만, 결정 3의 독립 생성기가 `Cs`에서 같은 축의 구멍을
 * 즉시 찾아냈다. 같은 근거(폭 없음·프로브는 매칭 전용 사본)가 그대로 적용된다.
 */
const LONE_SURROGATE_RE = /\p{Cs}/u;

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
 * 위 여섯 집합의 합집합이며, 이것이 "보이지 않거나 폭을 차지하지 않는 것"의 실무적 정의다.
 *
 * **범주 단위로만 넓힌다.** T-004에서 개별 문자를 열거하다 형제 문자를 네 번 놓쳤다
 * (F-8 → N-2 → N-6 → N-9). 열거는 언제나 "지금 아는 것"에서 멈추므로,
 * 유니코드 General_Category 전체를 덮는 쪽이 다음 형제를 미리 삼킨다.
 * 보이는 공백(`Zs`·`Zl`·`Zp`)과 사용자 정의 영역(`Co`)은 **일부러 뺐다** —
 * 자기 폭이나 글리프를 가져 시크릿을 눈에 보이게 끊으므로 일반 공백과 같은 취급이다.
 */
export const IGNORABLE_RE = new RegExp(
  [
    DEFAULT_IGNORABLE_RE.source,
    BLANK_RENDERING_RE.source,
    COMBINING_MARK_RE.source,
    FORMAT_RE.source,
    CONTROL_RE.source,
    LONE_SURROGATE_RE.source,
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


/**
 * 마스킹 프로브에서 이 문자를 만나면 프로브에 넣지 않는다.
 *
 * `\t`·`\n`·`\r`은 `Cc`지만 **되살린다.** 구조를 나르는 문자이고, 프로브에서 지우면
 * 줄 단위로 나뉜 입력이 한 줄로 붙어 mongo 규칙의 authority 경계 판정이 무너진다.
 * (URI 구조 파싱으로 바뀐 뒤에도 authority는 줄 안에서 끝나야 한다 — T-004 결정 1.)
 */
export function isIgnorable(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  return IGNORABLE_RE.test(char);
}

/** 프로브용. 위 판정에 걸리는 문자를 전부 제거한다. */
export function stripInvisible(text: string): string {
  let out = "";
  for (const char of text) {
    if (!isIgnorable(char)) out += char;
  }
  return out;
}
