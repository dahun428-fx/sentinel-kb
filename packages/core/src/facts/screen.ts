/**
 * 발행 안전 스크린. 팩트 팩에 실릴 **모든 문자열**이 여기를 통과해야 한다.
 * 출처: specs/08-publishing.md §7("sanitizeFlags 있는 레코드의 원문 인용 금지"), NFR-05.
 *
 * ## 왜 저장 경로의 새니타이저를 다시 쓰지 않고 더 조인가
 *
 * `sanitizer`(T-004)는 **기록을 남기는** 게이트다. 거기서는 과마스킹이 손해다 —
 * "어느 클러스터에서 터졌나"를 지우면 트러블슈팅 기록의 가치가 사라진다. 그래서 판정이
 * 애매하면 남기는 쪽으로 기운 자리가 있고, T-004 포스트모템 §4.4①이 그것을 명시한다:
 * **면제 경로는 무플래그 통과다.** `mongodb://appuser:Str0ng Pass@host`(F-21)나
 * NBSP가 낀 자격증명(F-18)은 마스킹도 플래그도 없이 레코드에 그대로 저장된다.
 *
 * 아티클은 반대 방향이다. 여기서 통과시킨 문자열은 **외부 공개 발행물**로 나가고,
 * 나간 뒤에는 되돌릴 수 없다. 반면 잘라 버리는 비용은 인용 후보 하나가 줄어드는 것뿐이다.
 * 그래서 이 파일의 판정은 전부 **fail-closed**다: 조금이라도 자격증명처럼 보이면 버린다.
 * 마스킹해서 살리지도 않는다 — §3이 인용 후보를 "원문 그대로"로 못박았으므로,
 * 손대야 하는 스니펫은 인용 후보가 될 자격이 없는 스니펫이다.
 *
 * ## 세 겹
 * 1. `containsSecretShape` — 저장 게이트가 잡는 것 + 그 게이트가 놓치는 면제 경로.
 * 2. `isMachineSnippet` — 인쇄 가능 ASCII만. 자연어 스크립트(한글·가나·한자)는 통과 못 한다.
 *    T-040이 밝힌 미탐 축(일본어)이 인용으로 새는 경로를 **탐지가 아니라 형상으로** 닫는다.
 * 3. `detectInjection` 재호출 — `<system>` 같은 구조 신호는 ASCII라서 2를 통과할 수 있다.
 */
import { detectInjection } from "../sanitizer/injection.js";
import { applyMasking } from "../sanitizer/masking.js";

/**
 * 스킴 뒤 authority에 `@`가 있는 URI. **마스킹 여부와 무관하게** 버린다.
 *
 * 이게 T-004 면제 경로(F-21·F-18)를 닫는 자리다. 저장 게이트는 자격증명 자리에 공백류가
 * 있으면 산문으로 보고 면제하는데, 그 면제가 없으면 F-15(정상 문장의 호스트 삭제)가
 * 재발하기 때문에 거기서는 없앨 수 없다. 여기서는 없앨 수 있다 — 산문을 인용 후보로
 * 쓰지 않으므로 오탐의 대가가 "URI 한 줄을 인용하지 못한다"뿐이다.
 */
const URI_USERINFO_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]*@/;

/** `key=value` 꼴로 자격증명 이름이 붙은 것. 값의 모양은 보지 않는다. */
const CREDENTIAL_ASSIGNMENT_RE =
  /(?:pass(?:word|wd)?|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth[_-]?token|client[_-]?secret)["'`]?\s*[:=]\s*\S/i;

/** PEM 블록 머리. 한 줄만 잡혀도 그 스니펫은 키 재료다. */
const PEM_HEADER_RE = /-----BEGIN[ A-Z]*(?:PRIVATE KEY|CERTIFICATE)-----/;

/** 저장 게이트가 삽입한 라벨. 라벨이 있다는 것은 그 자리에 시크릿이 있었다는 뜻이다. */
const MASK_LABEL_RE = /\[MASKED:/;

/**
 * 문맥 없이 떠 있는 40자 이상의 불투명한 런.
 *
 * 저장 게이트의 무앵커 규칙은 `[A-Za-z0-9/+=]{40}` **정확히 40자**만 본다(경계 룩어라운드).
 * 41자짜리 토큰이나 `-`·`_`가 섞인 JWT·URL-safe base64는 거기 걸리지 않는다.
 * 발행물에서는 그런 런을 인용할 이유가 없으므로 통째로 버린다.
 *
 * 면제 둘: 순수 hex(커밋 SHA — 트러블슈팅 기록에 매 문단 나온다)와
 * 대문자·숫자·밑줄만으로 된 이름(`MONGODB_SERVER_SELECTION_TIMEOUT_MS` 같은 env 변수명).
 * env 변수의 **값**은 위 `CREDENTIAL_ASSIGNMENT_RE`가 잡으므로 이 면제로 새지 않는다.
 */
const OPAQUE_RUN_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g;
const HEX_ONLY_RE = /^[0-9a-f]+$/i;
const SCREAMING_NAME_RE = /^[A-Z0-9_]+$/;

/** 인쇄 가능 ASCII + 탭만. 개행은 포함하지 않는다 — 스니펫은 한 줄이다. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7E\t]+$/;

/**
 * 이 문자열에 시크릿이 섞여 있을 **가능성이라도** 있는가.
 *
 * `applyMasking`을 이메일까지 켜서 한 번 돌리고(저장 시점 이후에 규칙이 좋아졌을 수 있다),
 * 그 위에 저장 게이트가 구조적으로 놓치는 축을 얹는다.
 */
export function containsSecretShape(text: string): boolean {
  if (text.length === 0) return false;
  if (MASK_LABEL_RE.test(text)) return true;
  if (URI_USERINFO_RE.test(text)) return true;
  if (CREDENTIAL_ASSIGNMENT_RE.test(text)) return true;
  if (PEM_HEADER_RE.test(text)) return true;
  if (hasOpaqueRun(text)) return true;
  // 마지막에 둔다 — 위 규칙들이 더 싸고, 여기까지 오면 저장 게이트와 같은 비용을 낸다.
  return applyMasking(text, true).masked.length > 0;
}

function hasOpaqueRun(text: string): boolean {
  for (const match of text.matchAll(OPAQUE_RUN_RE)) {
    const run = match[0];
    if (run === undefined) continue;
    if (HEX_ONLY_RE.test(run)) continue;
    if (SCREAMING_NAME_RE.test(run)) continue;
    return true;
  }
  return false;
}

/**
 * 기계가 식별한 스니펫의 형상인가 — 인쇄 가능 ASCII 한 줄인가.
 *
 * 에러 원문·명령어·경로·버전·URL은 전부 ASCII다. 한글·가나·한자가 섞였다면 그것은
 * 스니펫이 아니라 **산문**이고, 산문은 팩트가 아니다(`types.ts` 서두).
 * 이 한 줄이 T-040의 미탐 축(일본어 인젝션)을 인용 경로에서 원천 차단한다 —
 * 탐지 규칙을 언어마다 추가하는 방어와 달리 언어 수가 늘어도 약해지지 않는다.
 */
export function isMachineSnippet(text: string): boolean {
  return PRINTABLE_ASCII_RE.test(text);
}

/**
 * 발행물에 실려도 되는 스니펫인가. 세 겹을 모두 통과해야 한다.
 * `metric` 종류만 예외적으로 ASCII 요구를 면제한다(`allowNonAscii`) — 단위 어휘가
 * 닫힌 집합이라 `<숫자><단위>` 밖의 문자가 애초에 들어올 수 없기 때문이다.
 */
export function isPublishableSnippet(text: string, allowNonAscii = false): boolean {
  if (text.length === 0) return false;
  if (!allowNonAscii && !isMachineSnippet(text)) return false;
  if (containsSecretShape(text)) return false;
  return detectInjection(text).length === 0;
}

/**
 * 차트 축·분포 키로 실려도 되는 라벨인가 (태그·모델명·도구명·프로젝트명).
 *
 * 라벨에는 ASCII를 요구하지 않는다 — 한국어 태그는 정상이다. 대신 길이를 조이고
 * 인젝션·시크릿 형상을 본다. 라벨은 사람이 고른 짧은 분류값이므로, 길거나 문장처럼
 * 생겼다면 그것은 라벨이 아니라 다른 것이 라벨 칸에 들어온 것이다.
 */
export const MAX_LABEL_CHARS = 64;

export function isPublishableLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_CHARS) return false;
  if (containsSecretShape(trimmed)) return false;
  return detectInjection(trimmed).length === 0;
}
