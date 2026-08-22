/**
 * 언어를 열거하지 않는 인젝션 신호. 출처: specs/tasks/T-040, T-021 F-1,
 * docs/analysis/T-004-POSTMORTEM.md §2.5·§3.2.
 *
 * ## `injection.ts`와 **갈라 놓는** 이유
 *
 * 두 파일의 실패 성질이 다르다. `injection.ts`의 규칙은 자연어 단어를 본다 —
 * 언어가 하나 늘 때마다 규칙이 하나 필요하고, 없으면 **조용히 통과**한다(fail-open).
 * T-021이 그 성질을 실측했다: 일본어 `INJ-10`이 무플래그로 통과했고, 제외(`generator/context.ts`)는
 * `flags`만 보므로 방어선 2가 발동조차 하지 않았다.
 *
 * 포스트모템 §2.5가 이 성질에 이름을 붙였다:
 *
 * > 판정용 열거에 없는 문자를 만나면 규칙이 무발동하고, 무발동은 무플래그 평문 통과를 뜻한다.
 *
 * §3.2의 결론은 "이전 가능한 요인은 유니코드 속성 자체가 아니라 **생성기 독립성**"이다 —
 * 판정 근거가 구현자가 만든 목록이 아니라 **외부에 이미 있는 보편 술어**일 것.
 * 그래서 이 파일의 규칙은 둘 중 하나만 쓴다.
 *
 * 1. **외부 표준의 술어** — Unicode `Script` 속성, `Intl.Segmenter`(ICU 단어 경계).
 *    언어가 늘어도 이 파일은 바뀌지 않는다.
 * 2. **이 시스템 자신이 내보내는 문자열** — 컨테이너 태그, 대화 템플릿 특수 토큰.
 *    자연어가 아니므로 언어와 무관하다. 앵커는 손으로 베끼지 않고 에미터에서 기계적으로 대조한다
 *    (`injection.structural.spec.ts`의 `renderContext` 대조).
 *
 * **자연어 단어를 언어별로 늘리는 것은 이 파일에서 금지된다.** 그것이 T-004가 여덟 라운드 동안
 * 한 일이고, 매번 판정자만 바뀌었을 뿐 fail-open은 한 번도 제거되지 않았다.
 */

/**
 * 대화 템플릿의 **특수 토큰**. 자연어 산문에 원리적으로 나타나지 않는 모양이라
 * 언어와 무관하게 판정된다 — 일본어 인젝션도 `<|im_start|>`는 그대로 쓴다.
 *
 * `<|…|>`는 (ChatML·Llama·Qwen 계열이 공유하는) 토크나이저 예약 토큰의 형태 자체다.
 * 개별 토큰 이름(`im_start`·`endoftext`…)을 열거하지 않고 **모양**을 잡는 것이 요점이다 —
 * 이름을 열거하면 다음 모델의 토큰에서 그대로 fail-open 한다.
 */
const CHAT_TEMPLATE_TOKEN_RE = /<\|[\p{L}\p{N}_-]{1,32}\|>|\[\/?INST\]|<<\/?SYS>>/u;

/**
 * 역할 프레임 위조. `<system>`·`</system>`만 본다.
 *
 * `<user>`·`<assistant>`를 넣지 않은 것은 의도다 — `<user>`·`<db user name>` 류의 **자리표시자**가
 * 실제 기록에 흔하고(T-004 N-3이 `mongodb://<db user name>:…`로 실측했다), 그쪽은
 * 오탐이 곧 R-8(기록이 자기 본문 때문에 플래그돼 지식이 안 읽히는 문제)이다.
 * `<system>`은 자리표시자로 쓸 이유가 없다.
 */
const ROLE_FRAME_RE = /<\/?system\s*>/iu;

/**
 * 이 시스템이 **실제로 내보내는** 컨테이너의 닫는 태그.
 *
 * 출처는 자연어가 아니라 코드다: `generator/context.ts`의 `renderContext`가 `<chunk>`·
 * `<retrieved-chunks>`를 내보내고 `packages/mcp`의 `get_record` 래핑이 `<retrieved-record>`를
 * 내보낸다. `renderContext`가 `</chunk>`를 escape한다는 사실 자체가 **이 문자열이 공격 모양임을
 * 시스템이 이미 인정하고 있다**는 뜻인데, 정작 새니타이저는 그것을 신호로 세지 않았다.
 *
 * 이름을 여기 베껴 적었으므로 에미터가 바뀌면 갈라진다 — 그 갈라짐을
 * `injection.structural.spec.ts`가 `renderContext` **실 출력에서 태그를 추출해** 잠근다.
 * (`invisible.ts`가 마스킹과 인젝션의 제로폭 집합을 한곳에 모은 것과 같은 이유다.)
 */
export const EMITTED_CONTAINER_TAGS = ["chunk", "retrieved-chunks", "retrieved-record"] as const;

const CONTAINER_ESCAPE_RE = new RegExp(`</(?:${EMITTED_CONTAINER_TAGS.join("|")})\\s*>`, "iu");

/**
 * 단어 경계. **로케일을 `"en"`으로 고정한다** — 기본 로케일을 쓰면 개발자 셸의
 * `LANG`에 따라 경계가 달라져 같은 입력이 다른 결과를 낸다(T-004 F-4와 같은 종류의 환경 결합).
 * 일본어·중국어·태국어의 사전 기반 분절은 ICU가 로케일과 무관하게 수행한다.
 */
const WORD_SEGMENTER = new Intl.Segmenter("en", { granularity: "word" });

const LETTER_RE = /\p{L}/u;
/** `Common`·`Inherited` 글자(`µ`·`ª` 등)는 어느 문자체계에도 속하지 않으므로 판정에서 뺀다. */
const SCRIPT_NEUTRAL_RE = /[\p{Script=Common}\p{Script=Inherited}]/u;
const LATIN_RE = /\p{Script=Latin}/u;
/**
 * UTS #39가 "augmented script set"으로 묶는 CJK 계열. 한 단어 안에서 섞이는 것이 **정상**이다 —
 * 일본어는 한자·히라가나·가타카나를 한 단어에 쓰고, 한국어는 한자를 병기한다
 * (`국립중앙도서관國立中央圖書館`). 묶지 않으면 일본어 기록 전체가 오탐된다.
 */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
/**
 * 키릴·그리스를 **각자의 계열로** 가른다. UTS #39가 라틴의 대표적 confusable 공여자로 지목하는
 * 둘이고, 서로에 대해서도 동형이다(키릴 `о` U+043E ↔ 그리스 `ο` U+03BF ↔ 라틴 `o`).
 *
 * 뭉뚱그려 `other` 한 바구니에 넣으면 **키릴 단어에 그리스 동형 문자를 끼우는 우회**가
 * 그대로 통과한다 — 뮤테이션 M7이 그 구멍을 살아남아 실증했고, 그래서 갈랐다.
 * 여기 없는 문자체계는 `other`로 떨어지지만 라틴·CJK·키릴·그리스와는 여전히 구별되므로
 * 주 공격축에 대해 fail-open이 되지 않는다.
 */
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const GREEK_RE = /\p{Script=Greek}/u;

type ScriptClass = "latin" | "cjk" | "cyrillic" | "greek" | "other";

/**
 * 판정 대상 단어의 **최소 글자 수**.
 *
 * 동형 문자 우회는 "여러 글자 중 한둘만 바꿔치기"라는 모양을 갖는다(`Ignоre`= 라틴 5 + 키릴 1).
 * 반면 두세 글자짜리 혼합은 기술 산문의 **정상 표기**다 — `Δt`(그리스+라틴), `ΔT`, `βv` 같은
 * 물리량 표기가 그렇다. 상한이 아니라 하한을 두는 이유는 오탐이 이 태스크의 진짜 위험이기
 * 때문이다(R-8): 미탐 하나는 다른 방어선이 받지만, 오탐은 기록을 읽을 수 없게 만든다.
 */
const MIN_WORD_LETTERS = 4;

function scriptClassOf(char: string): ScriptClass | undefined {
  if (!LETTER_RE.test(char) || SCRIPT_NEUTRAL_RE.test(char)) return undefined;
  if (LATIN_RE.test(char)) return "latin";
  if (CJK_RE.test(char)) return "cjk";
  if (CYRILLIC_RE.test(char)) return "cyrillic";
  if (GREEK_RE.test(char)) return "greek";
  return "other";
}

/**
 * **한 단어 안에서** 문자체계가 섞였는가 (UTS #39 mixed-script detection의 축소판).
 *
 * 이것이 닫는 구멍은 T-021이 재지 않은 쪽이고, 일본어 미탐보다 더 크다:
 * `Ignore`의 `o`를 키릴 `о`(U+043E)나 그리스 `ο`(U+03BF)로 한 글자 바꾸면
 * **`en-*` 규칙 12개가 전부 빗나간다.** 실측으로 `Ignоre all previous instructions`는
 * 무플래그 통과했다. 즉 공격자는 언어를 바꿀 필요조차 없었다.
 *
 * 판정 근거는 목록이 아니라 Unicode `Script` 속성이므로, 다음 동형 문자가 어느 문자체계에서
 * 오든 자동으로 들어온다 — `invisible.ts`가 `\p{Cf}`로 형제 문자를 미리 삼킨 것과 같은 성질이다.
 *
 * **단어 경계를 ICU에 맡기는 것이 오탐 방지의 핵심이다.** 한국어 기술 산문은
 * `terraform apply가`처럼 라틴과 한글을 붙여 쓰는데, 인접 문자만 보면 이게 전부 오탐이 된다.
 * `Intl.Segmenter`는 이것을 `apply` + `가`로 가른다.
 */
export function hasMixedScriptWord(text: string): boolean {
  for (const segment of WORD_SEGMENTER.segment(text)) {
    if (!segment.isWordLike) continue;
    const classes: ScriptClass[] = [];
    for (const char of segment.segment) {
      const cls = scriptClassOf(char);
      if (cls !== undefined) classes.push(cls);
    }
    if (classes.length < MIN_WORD_LETTERS) continue;
    if (classes.some((cls) => cls !== classes[0])) return true;
  }
  return false;
}

interface StructuralRule {
  readonly id: string;
  readonly test: (text: string) => boolean;
}

/** 반환 순서를 선언 순서로 고정한다(결정론) — `injection.ts`의 규칙 배열과 같은 규약이다. */
const STRUCTURAL_RULES: readonly StructuralRule[] = [
  { id: "struct-chat-template-forgery", test: (t) => CHAT_TEMPLATE_TOKEN_RE.test(t) },
  { id: "struct-role-frame-forgery", test: (t) => ROLE_FRAME_RE.test(t) },
  { id: "struct-container-escape", test: (t) => CONTAINER_ESCAPE_RE.test(t) },
  { id: "struct-mixed-script-word", test: hasMixedScriptWord },
];

/**
 * 구조 신호로 **닫히지 않는** 축. 비워 두지 않고 선언하는 것이 요점이다 —
 * T-021 `corpus.ts`가 `targetRules: []`를 "기대 없음"이 아니라 "대응 규칙 부재의 선언"으로
 * 쓴 것과 같다. 여기 적히지 않은 축은 "닫혔다"는 주장이고, 그 주장은 테스트가 진다.
 *
 * **이 목록은 늘어나면 안 된다.** 늘리려면 그건 새 태스크의 근거이지 이 파일의 편집이 아니다.
 */
export const KNOWN_STRUCTURAL_GAPS = [
  {
    axis: "plain-prose-directive-non-ko-en",
    why:
      "마크업도 난독화도 없는 **평문 지시문**이 ko·en 아닌 언어로 쓰인 경우. " +
      "표면 통계로는 갈리지 않는다 — 실측으로 적대 12건과 정상 15건의 문자수·문장수·단어수· " +
      "문자체계 수 분포가 완전히 겹쳤다(T-040 리포트). 가르는 것은 문법적 서법(명령형/서술형)과 " +
      "메타 참조 어휘뿐이고 둘 다 언어별 지식이다. " +
      "외부 보편 술어가 존재하지 않는 축이므로 포스트모템 §3.1의 판정이 그대로 적용된다.",
    next: "의미 계층이 필요하다. `packages/core/src/embedder`의 다국어 임베딩으로 인젝션 **의도** " +
      "앵커와의 코사인을 재면 언어 축이 모델로 넘어간다(언어를 늘려도 코드는 안 바뀐다). " +
      "다만 저장 경로는 동기 게이트라(`sanitize.ts` 서두) 계층이 다르고, 새 `SanitizeFlag`는 " +
      "contracts 재개방(G3)이다. 별도 태스크 + 사람 승인.",
  },
  {
    axis: "turn-marker-forgery",
    why:
      "`Human:` / `Assistant:` 줄로 대화 턴을 위조하는 축. 모양은 언어 무관이지만 **일부러 뺐다** — " +
      "이 레포의 도그푸딩 프로토콜은 에이전트 트랜스크립트를 divergence 기록에 인용하도록 " +
      "권장한다(CLAUDE.md). 그 기록이 자기 본문 때문에 플래그되면 R-8 그대로다. " +
      "오탐 코퍼스에서 실측 0건이었지만, 코퍼스에 아직 트랜스크립트 인용 기록이 없어서 " +
      "**0건은 안전의 증거가 아니라 표본의 공백**이다.",
    next: "트랜스크립트를 인용하는 실제 기록이 시드에 들어온 뒤 그 코퍼스로 오탐을 재고 결정한다.",
  },
] as const;

/** 발화한 구조 규칙 id. 비어 있으면 구조 신호 없음. */
export function detectStructural(text: string): readonly string[] {
  return STRUCTURAL_RULES.filter(({ test }) => test(text)).map(({ id }) => id);
}
