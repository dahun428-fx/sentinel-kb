/**
 * 프롬프트 인젝션 의심 패턴. 출처: specs/tasks/T-004 Scope, specs/05 Eval 4.
 *
 * **여기서는 아무것도 지우지 않는다.** 플래그만 단다(T-004: "플래그는 마스킹하지 않고
 * 표시만 한다 — 지식 자체는 보존"). 인젝션 문구 자체가 지식인 경우가 많다:
 * "이 프롬프트가 에이전트를 탈선시켰다"는 divergence 기록의 본문이 곧 인젝션 문구다.
 * 지우면 재현 조건이 사라진다.
 *
 * ## 오탐 방지 설계
 * 단순 키워드 매칭("system prompt"가 들어 있으면 플래그)은 이 레포에서 즉시 무너진다.
 * "시스템 프롬프트를 수정해서 해결했다"는 **가장 흔한 정상 기록**이기 때문이다.
 * 그래서 세 축으로 좁혔다.
 *
 * 1. **동사 + 목적어의 공기(共起)를 본다.** 명사만으로는 절대 발화하지 않는다.
 *    노출·무력화 계열 동사(reveal/output/무시/공개…)가 "system prompt / 이전 지시"와
 *    한 문장 안에서 결합할 때만 잡는다. 교정 계열 동사(edit/fix/수정/변경)는 목록에 없다.
 * 2. **명령형 대 서술형을 구분한다.** 한국어는 어미가 갈라준다.
 *    "무시하고 ~해줘"(명령) 대 "무시하도록 설정돼 있었다"(서술) — 후자는 부정 룩어헤드로 제외한다.
 * 3. **수신자가 어시스턴트인지 본다.** "너는 이제", "you are now a ..." 처럼 2인칭
 *    역할 지정이 있어야 역할 전환으로 본다. 기록문은 시스템을 3인칭으로 서술한다.
 */

import { ZERO_WIDTH_RE, stripInvisible } from "./invisible.js";
import { detectStructural } from "./structural.js";


/**
 * 제로폭 문자 허용 한도. 웹에서 복사한 텍스트에 한두 개 섞이는 건 흔하다.
 * 이 수를 **초과**하면 "과도"로 본다(T-004 Scope).
 */
export const ZERO_WIDTH_THRESHOLD = 3;

/**
 * 매칭 전용 사본. 원문은 절대 바꾸지 않는다.
 * - NFKC: 전각 문자로 정규식을 피해 가는 회피를 막는다.
 * - 제로폭 제거: `i␏g␏n␏o␏r␏e` 류 삽입 회피를 막는다.
 * - 공백 축약: 줄바꿈·탭으로 쪼갠 지시문을 한 줄로 되돌린다.
 */
export function toProbe(text: string): string {
  return stripInvisible(text.normalize("NFKC")).replace(/\s+/g, " ");
}

interface InjectionPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    // "ignore all previous instructions" — 무력화 동사와 지시 명사가 한 문장에 함께 있을 때만.
    // "Ignore the deprecation warning from the previous build step"는 뒤쪽 명사가 없어 통과한다.
    id: "en-ignore-previous-instructions",
    pattern:
      /\b(?:ignore|disregard|forget|discard|override)\b[^.\n]{0,40}\b(?:previous|prior|above|preceding|earlier|all|any)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines?)\b/i,
  },
  {
    // 2인칭 역할 재지정. 뒤에 역할·상태를 가리키는 말이 와야 한다.
    id: "en-role-switch",
    pattern:
      /\byou(?:'re| are)\s+now\s+(?:a|an|the|no longer|allowed|free|permitted|operating|acting|in\s+\S+\s+mode)\b/i,
  },
  {
    // "from now on you must ..." — 이후 행동 규범을 갈아끼우는 형태.
    id: "en-from-now-on",
    pattern: /\bfrom now on\b[^.\n]{0,20}\byou\s+(?:are|will|must|should|shall|can|may)\b/i,
  },
  {
    // 시스템 프롬프트 노출·교체 요구. 동사 목록에 edit/fix/update가 없는 것이 핵심이다.
    id: "en-system-prompt-exposure",
    pattern:
      /\b(?:reveal|print|show|output|repeat|disclose|dump|leak|ignore|override|replace|forget|bypass|reset)\b[^.\n]{0,30}\b(?:system|initial|original|developer)\s+(?:prompts?|instructions?|messages?)\b/i,
  },
  {
    id: "en-jailbreak-mode",
    pattern: /\b(?:developer mode|dan mode|jailbreak|do anything now)\b/i,
  },
  {
    id: "en-bypass-guardrails",
    pattern:
      /\b(?:override|bypass|disable|ignore|turn off|circumvent)\b[^.\n]{0,25}\b(?:safety|guardrails?|restrictions?|filters?|safeguards?|policies)\b/i,
  },
  {
    id: "en-pretend-role",
    pattern: /\b(?:pretend|roleplay|role-play)\b[^.\n]{0,20}\b(?:to be|that you|you are|as an?)\b/i,
  },
  {
    // "이전 지시를 무시하고 ..." (specs/05 Eval 4의 예시 그대로).
    // 부정 룩어헤드가 서술형("무시하도록 설정됐다", "무시해서 터졌다", "무시했다")을 걸러낸다.
    id: "ko-ignore-previous-instructions",
    pattern:
      /(?:이전|앞의|위의|기존|모든|지금까지의)\s*(?:모든\s*)?(?:지시|지침|명령|프롬프트|규칙)(?:\s*사항)?[은는을를]?\s*(?:전부|모두|다)?\s*(?:무시|잊)(?!하도록|하게|해서|했|하지|하면|어서|어버려서)/,
  },
  {
    // 2인칭 역할 재지정의 한국어 변형. 기록문은 시스템을 3인칭으로 서술하므로 오탐이 낮다.
    id: "ko-role-switch",
    pattern: /(?:지금부터|이제부터)\s*(?:너는|당신은|넌|네가|당신이)|(?:너는|당신은|넌)\s*이제/,
  },
  {
    // 시스템 프롬프트 노출·무력화 요구. "수정/변경/개선"은 목록에 없다 —
    // "시스템 프롬프트를 수정해서 해결했다"는 정상 기록이다.
    id: "ko-system-prompt-exposure",
    pattern:
      /(?:시스템|초기|원래)\s*프롬프트[를을]?\s*(?:그대로\s*)?(?:출력|공개|노출|보여|알려|말해|무시|덮어|전송|복사)/,
  },
  {
    id: "ko-pretend-role",
    pattern: /(?:인\s*척\s*(?:해|하고|하라)|역할[을를]?\s*(?:바꿔|전환해|바꾸고))/,
  },
];

/**
 * 매칭된 규칙 id 목록. 비어 있으면 인젝션 의심 아님.
 * 반환 순서는 `INJECTION_PATTERNS` → 구조 규칙 → 제로폭 순으로 고정된다(결정론).
 *
 * 위 자연어 규칙과 `structural.ts`의 구조 규칙은 **성질이 다르다.**
 * 전자는 언어가 하나 늘 때마다 규칙이 하나 필요하고 없으면 조용히 통과한다(T-021 F-1).
 * 후자는 판정 근거가 Unicode 속성과 이 시스템 자신의 출력 문자열이라 언어와 무관하다.
 * 섞어 두면 그 차이가 안 보이므로 파일을 갈라 놓았다 — `structural.ts` 서두 참조.
 */
export function detectInjection(text: string): readonly string[] {
  const probe = toProbe(text);
  const hits = INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(probe)).map(({ id }) => id);

  // 구조 신호도 프로브를 본다. 전각 `＜system＞`·제로폭 삽입으로 태그를 쪼개는 우회를
  // `toProbe`가 이미 접어 주므로 그 위에 서면 된다(T-040 Scope).
  const structural = detectStructural(probe);

  // 제로폭 검사만 원문을 본다 — 프로브는 이미 제로폭을 지운 상태다.
  const zeroWidthCount = text.match(ZERO_WIDTH_RE)?.length ?? 0;
  if (zeroWidthCount > ZERO_WIDTH_THRESHOLD) {
    return [...hits, ...structural, "zero-width-abuse"];
  }
  return [...hits, ...structural];
}
