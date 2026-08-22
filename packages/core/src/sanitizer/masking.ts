/**
 * 시크릿 마스킹 규칙. 출처: specs/00-product.md FR-06, specs/tasks/T-004 Scope.
 *
 * 세 가지 설계 결정이 이 파일 전체를 지배한다.
 *
 * 1. **라벨로 마스킹한다.** `AKIA****` 같은 별표가 아니라 `[MASKED:aws-access-key]`.
 *    specs/07 §3이 "마스킹이 발생하면 무엇이 마스킹됐는지 알려준다(조용히 삼키지 않음)"고
 *    요구하기 때문이다. 원문 시크릿은 한 글자도 남기지 않으므로 복원은 불가능하다.
 *    치환 구간은 정규화 좌표계의 매치를 **원문 문자 경계까지 넓혀** 되돌린 것이라
 *    시크릿 중간·끝에 낀 제로폭 문자까지 함께 삼킨다.
 *
 * 2. **정규화 좌표계에서 찾고 원문 좌표계에서 지운다.** 정규식을 원문에 직접 돌리면
 *    `AKIA<ZWSP>IOSFODNN7EXAMPLE`이나 전각 `ＡＫＩＡ...`가 통째로 빠져나간다.
 *    그래서 제로폭을 제거하고 문자별 NFKC를 적용한 **프로브**에서 매치를 찾은 뒤,
 *    문자 단위 매핑으로 원문 구간을 복원해 그 구간을 라벨로 바꾼다.
 *    문자열 전체 NFKC가 아니라 **문자별** NFKC인 이유는 전체 정규화가 문자 경계를
 *    합쳐(예: 조합형 → 완성형) 매핑을 깨뜨리기 때문이다.
 *
 * 3. **진단 정보는 남긴다.** 사설 IP(10.x/172.16-31.x/192.168.x/127.x)는 마스킹 대상이
 *    아예 아니고, mongodb URI도 자격증명만 지우고 호스트·DB명은 보존한다.
 *    "어느 클러스터에서 터졌나"가 트러블슈팅의 핵심 단서다.
 *
 * 위험 비대칭: **미탐 > 오탐.** 오탐은 진단 정보 한 줄이 가려지는 것이지만,
 * 미탐은 시크릿이 레코드·청크·임베딩·LLM 컨텍스트로 영구히 퍼지는 것이다.
 * 판정이 애매하면 마스킹하는 쪽으로 기운다.
 *
 * 결정론: 정규식만 쓴다. LLM 호출 없음 — 저장 경로의 동기 게이트다(T-004).
 */

import { isIgnorable } from "./invisible.js";

/** 마스킹된 값의 종류. 본문에 라벨로 남아 "무엇이 가려졌는지"를 알린다. */
export const MASK_KINDS = [
  "aws-access-key",
  "aws-secret-key",
  "bearer-token",
  "api-key",
  "db-credentials",
  "email",
] as const;

export type MaskKind = (typeof MASK_KINDS)[number];

/** 본문에 삽입되는 마스킹 라벨. */
export function maskLabel(kind: MaskKind): string {
  return `[MASKED:${kind}]`;
}

export interface MaskingResult {
  readonly text: string;
  /** 실제로 마스킹이 일어난 종류(등장 순서 무관, 정렬된 중복 없는 목록). */
  readonly masked: readonly MaskKind[];
}

// ---------------------------------------------------------------------------
// 정규화 프로브와 원문 좌표 매핑
// ---------------------------------------------------------------------------


interface NormalizedProbe {
  /** 제로폭 제거 + 문자별 NFKC를 적용한 매칭 전용 사본. */
  readonly probe: string;
  /** `probe[i]`가 유래한 원문 문자의 시작 인덱스. */
  readonly srcStart: readonly number[];
  /** `probe[i]`가 유래한 원문 문자의 끝 인덱스(exclusive). */
  readonly srcEnd: readonly number[];
}

/**
 * 원문을 코드포인트 단위로 훑어 프로브와 좌표 매핑을 동시에 만든다.
 *
 * - 제로폭 문자는 프로브에 넣지 않는다(스킵). 매핑에도 자리를 만들지 않는다.
 * - 나머지는 **문자별로** NFKC 정규화해 넣는다. 한 문자가 여러 글자로 늘어나면
 *   (`ﬁ` → `fi`) 늘어난 전부가 같은 원문 문자 구간을 가리킨다.
 * - ASCII는 NFKC 불변이라 정규화를 건너뛴다. 100KB 입력에서 `normalize()`를
 *   문자마다 부르지 않기 위한 유일한 최적화다.
 */
function normalizeWithMap(text: string): NormalizedProbe {
  const parts: string[] = [];
  const srcStart: number[] = [];
  const srcEnd: number[] = [];

  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const nextIndex = index + char.length;

    // 지름길은 **인쇄 가능한 ASCII**에만 준다. 제어문자까지 그냥 통과시키면 프로브와 원문
    // 양쪽에 남아 두 패스를 동시에 깬다(T-004 N-7). 0x20~0x7E는 NFKD 불변이라 안전하다.
    if (codePoint >= 0x20 && codePoint < 0x7f) {
      parts.push(char);
      srcStart.push(index);
      srcEnd.push(nextIndex);
    } else if (!isIgnorable(char)) {
      const normalized = stripMarks(char.normalize("NFKD"));
      if (normalized.length === 0) {
        index = nextIndex;
        continue;
      }
      parts.push(normalized);
      // 매핑은 **코드유닛**마다 하나여야 한다 — 정규식 매치 인덱스가 코드유닛 단위이기 때문이다.
      // 한 문자가 여러 글자로 늘어나면 늘어난 전부가 같은 원문 문자 구간을 가리킨다.
      srcStart.push(...Array.from({ length: normalized.length }, () => index));
      srcEnd.push(...Array.from({ length: normalized.length }, () => nextIndex));
    }

    index = nextIndex;
  }

  return { probe: parts.join(""), srcStart, srcEnd };
}

// ---------------------------------------------------------------------------
// 자리표시자 판정
// ---------------------------------------------------------------------------

/**
 * 반복 기호 자리표시자. `xxx`, `***`, `...`, `----` 같은 표기.
 */
const REPEATED_SYMBOL_PLACEHOLDER_RE = /^[*x·.\-_]{2,}$/i;

/**
 * 꺾쇠 자리표시자. **명백한 것만** 인정한다:
 * 안쪽이 1~19자이고 영문자·하이픈·언더스코어·공백만으로 이뤄진 경우.
 *
 * 이 범위를 좁게 잡는 것이 핵심이다. `<svcuserFAKE0000>`처럼 숫자가 섞였거나
 * 20자를 넘는 것은 문서 템플릿이 아니라 "꺾쇠로 감싼 실제 값"일 가능성이 높다.
 * `${VAR}`·`$VAR`는 **자리표시자로 인정하지 않는다** — 셸 보간 표기일 뿐
 * 그 자리에 실제 값이 들어 있지 않다는 보장이 전혀 없기 때문이다.
 */
const ANGLE_PLACEHOLDER_RE = /^<[A-Za-z][A-Za-z _-]{0,18}>$/;

function isPlaceholder(value: string): boolean {
  return REPEATED_SYMBOL_PLACEHOLDER_RE.test(value) || ANGLE_PLACEHOLDER_RE.test(value);
}

// ---------------------------------------------------------------------------
// 규칙: 프로브 좌표계의 마스킹 구간을 낸다
// ---------------------------------------------------------------------------

/** 프로브 좌표계의 마스킹 대상 구간. `[start, end)`가 라벨 하나로 바뀐다. */
interface MaskSegment {
  readonly start: number;
  readonly end: number;
  readonly kind: MaskKind;
}

type MaskRule = (probe: string) => readonly MaskSegment[];

/** `matchAll`의 `index`는 타입상 optional이지만 전역 정규식에서는 항상 존재한다. */
function matchIndex(match: RegExpMatchArray): number {
  return match.index ?? 0;
}

/**
 * mongodb URI의 자격증명. 호스트·DB·쿼리스트링은 그대로 둔다.
 *
 * **사용자와 비밀번호를 따로 판정한다.** `<user>:진짜비번@host`는 문서 템플릿에
 * 비번만 채워 붙여넣은 형태로, 트러블슈팅 기록에서 가장 흔한 유출 경로다.
 * 한쪽이 자리표시자라고 다른 쪽까지 통과시키면 그 비번이 그대로 저장된다.
 * 둘 다 실제 값이면 `user:pass` 전체를 라벨 하나로 합쳐 지운다.
 *
 * 경계를 어떻게 정하는지는 바로 아래 주석 블록에 있다 — 그 순서가 T-004에서 가장 여러 번
 * 옆칸을 연 자리다.
 */
// ## 왜 "authority 끝"이 아니라 "`@` 후보 + 호스트 모양"인가 (T-004 결정 1 개정)
//
// userinfo와 산문을 **문자 클래스로** 가르려는 시도가 세 번 실패했다.
// 공백을 배제하면 `<db user name>:realpw@host`에서 규칙이 통째로 무발동해 비밀번호가 통과했고
// (N-3), 공백을 허용하니 `mongodb://localhost:27017 에서 실패, @team 에 공유` 같은 정상 문장의
// **호스트가 지워졌다**(F-15). 호스트 룩어헤드로 그 오탐을 막으니 compose 서비스명
// (`@mongo`·`@db`·`@localhost`)이 호스트로 인정되지 않아 비밀번호가 다시 샜다(N-8).
//
// 그래서 구조 파싱으로 갔는데, 첫 판(5차)은 **authority의 끝을 먼저 정하고 그 안에서
// 마지막 `@`를 찾는** 순서였다. 이 순서가 새 구멍을 냈다(N-10): authority 종료 문자
// (`/`·`?`·공백류)가 **비밀번호 안에** 들어 있으면 파서가 거기서 authority를 끝내
// `@`를 못 찾고 **자격증명 전체가 플래그도 없이 평문으로 통과**한다.
// `mongodb://appuser:Str0ngPass?x@cluster0.example.net/db`가 그대로 샜다.
//
// 순서를 뒤집는다. **경계 후보를 먼저 고르고, 그 뒤가 호스트처럼 보이는지로 검증한다.**
// 비밀번호에 어떤 글자가 들어 있든 `@` 뒤의 호스트는 여전히 호스트 모양이므로
// 판정 근거가 비밀번호 내용에 의존하지 않는다.
//
//   1. `mongodb://` | `mongodb+srv://` 스킴을 찾는다(대소문자 무시).
//   2. 스킴 뒤부터 **줄 끝까지**(개행 전까지, 상한 `MAX_USERINFO_SCAN`) 훑는다.
//   3. 그 구간의 `@`를 **뒤에서부터** 보며 뒤가 호스트 모양인지 검사한다:
//      `[A-Za-z0-9._-]+(:\d{1,5})?` 또는 `\[IPv6\](:\d{1,5})?` 뒤에
//      `/`·`?`·`#`·공백류·줄끝 중 하나가 와야 한다.
//   4. 호스트 모양을 통과한 `@`에 대해 **userinfo 정당성**을 따진다(아래 두 갈래).
//      통과하면 그게 경계고, 실패하면 다음 `@`로 계속 물러난다.
//   5. userinfo를 **첫 `:`** 로 user/pass로 가르고 **각각** 판정한다
//      (한쪽이 자리표시자여도 다른 쪽은 지운다).
//
// userinfo 정당성 검사가 F-15 오탐을 막는 **유일한** 방어선이다. 3번만으로는
// `mongodb://localhost:27017 에서 문제 발생, @team 에 공유했다.`의 `@team`이 호스트 모양을
// 통과해 userinfo = `localhost:27017 에서 문제 발생, `가 되고 호스트가 지워진다.
//
// **엄격 갈래**: RFC 3986 userinfo 문자집합 + 실무 예외 `?`·`/`·`@`.
//   공백도 한글도 제어문자도 없다. `Str0ngPass?x`·`Str0ngPass/x`·`P@ssw0rdLong`이 여기 걸린다.
//   (`?`·`/`는 RFC userinfo에 **없지만** 이스케이프 없이 들어오는 것이 현실이고,
//    그게 N-10 회귀의 핵심 케이스다. `@`도 같은 이유 — `svc:P@ssw0rdLong@host`.)
// **관대 갈래**: 공백이 있어도 되지만 **`:`가 반드시 있고**, 비밀번호 쪽은
//   **후행 공백만 트림한 뒤 내부 공백이 남지 않아야** 한다.
//   `<db user name>:realpw@host`(N-3)와 `appuser:Str0ngPass @host`(후행 공백)가 여기 걸리고,
//   `localhost:27017 에서 문제 발생, `는 비밀번호 자리에 **내부** 공백이 있어 탈락한다(F-15).
//
// **개행은 명시적으로 포기한다.** `mongodb://user:pw\n@host`처럼 URI가 줄을 넘는 형태는
// 산문과 구별할 구조적 근거가 없다 — 개행 하나만 허용해도 문단 전체가 userinfo 후보가 된다.
// F-19(`:` 없는 형태 포기)와 같은 취급이다. `\r`는 개행으로 보지 않고 공백류로 다룬다.

/**
 * userinfo 경계를 찾는 스캔 상한(문자 수).
 *
 * 상한이 필요한 이유는 정확도가 아니라 **비용**이다. 스킴 매치마다 줄 끝까지 훑으면
 * `mongodb://mongodb://…` 같은 입력에서 매치 수 × 줄 길이가 되어 이차로 튄다(F-11과 같은 축).
 * 512자는 MongoDB 사용자명·비밀번호 실사용 길이(합쳐도 256자를 넘지 않는다)의 두 배다.
 * 이 밖으로 밀려난 자격증명은 포기한다 — 개행 포기와 같은 성격의 명시적 한계다.
 */
const MAX_USERINFO_SCAN = 512;

/** 공백류. JS `\s`는 NBSP·EN/EM SPACE·U+3000·U+205F·U+1680·U+2028/2029를 모두 덮는다. */
const SPACE_RE = /\s/u;

/**
 * RFC 3986 userinfo 문자집합 + 퍼센트 인코딩 + 실무 예외(`?`·`/`·`@`).
 * `unreserved = A-Za-z0-9-._~`, `sub-delims = !$&'()*+,;=`, 그리고 `:`·`%`.
 * `?`·`/`는 RFC userinfo에 없지만 실무에서 이스케이프 없이 들어오므로 예외로 허용한다(N-10).
 *
 * **`@`는 넣지 않는다.** 넣으면 런이 비밀번호 안의 `@`를 삼키고, strict 갈래가 그 런의
 * 마지막 `@`를 경계로 **즉시 반환**해 버린다. 비밀번호에 `@`가 있고 그 뒤에 이 집합 밖 문자
 * (`#`·`[`·`{`·한글·이모지 등)가 오면 런이 진짜 경계 앞에서 끊겨
 * **비밀번호 내부의 `@`가 경계로 뽑히고 나머지 비밀번호가 평문으로 남는다** (T-004 N-12).
 * `flags`에는 `secret-masked`가 붙으므로 **"새니타이즈됨"으로 보이는데 비밀번호가 들어 있다.**
 * `@`를 빼면 strict 런이 `@`에서 끊겨 strict가 실패하고, lenient가 올바른 마지막 `@`를 찾는다.
 */
const STRICT_USERINFO_RE = /[A-Za-z0-9\-._~%!$&'()*+,;=:?/]/;

/** 개행 전까지가 한 줄이다. `\r`는 여기 포함하지 않는다 — 공백류로 다룬다. */
function lineEndFrom(subject: string, from: number): number {
  const newline = subject.indexOf("\n", from);
  return newline < 0 ? subject.length : newline;
}

/**
 * userinfo 경계(`@`의 위치)를 찾는다. 없으면 `-1`.
 *
 * 두 갈래를 순서대로 본다. **엄격이 먼저**인 이유는 그쪽이 `:` 없는 형태
 * (`mongodb://svcuser@host`)까지 인정하는 더 넓은 판정이기 때문이다.
 * 관대 갈래는 공백을 허용하는 대신 `:`와 "비밀번호에 내부 공백 없음"을 요구한다.
 */
/**
 * `@` 뒤에 호스트가 **존재하는지**만 본다. 모양은 보지 않는다.
 *
 * 6차까지 `@` 뒤를 `[A-Za-z0-9._-]{1,255}(:\d{1,5})?` + 종료문자 열거로 검증했는데,
 * 그 **열거가 여섯 번째 옆칸(N-11)**이었다 — 마크다운 백틱·괄호·한국어 마침표·
 * 레플리카셋 쉼표·`$PORT` 보간이 전부 "호스트 아님"으로 판정돼 규칙이 무발동했고,
 * 무발동은 **무플래그 평문 통과**를 뜻했다. 열거에 없는 문자 = 조용한 유출이라는 성질은
 * 여섯 라운드 내내 제거되지 않았다.
 *
 * 그래서 모양 검증을 통째로 걷어냈다. F-15(정상 산문의 호스트 삭제) 방어는
 * **userinfo 정당성 검사만으로 성립한다** — strict 런은 공백에서 끊기고,
 * lenient는 비밀번호 내부 공백을 배제한다. 호스트 검증은 덧붙인 열거였을 뿐이다.
 *
 * 남긴 조건은 하나뿐이고 그것은 열거가 아니라 **구조적 최소**다:
 * `@`가 스팬 맨 끝이면 뒤에 호스트가 존재할 수 없으므로 경계가 아니다
 * (`...?appName=svc@` 같은 꼬리 `@`).
 */
function hasHostAfter(subject: string, at: number, spanEnd: number): boolean {
  return at + 1 < spanEnd;
}

function findUserinfoEnd(subject: string, authorityStart: number): number {
  const spanEnd = Math.min(lineEndFrom(subject, authorityStart), authorityStart + MAX_USERINFO_SCAN);

  // --- 엄격 갈래 ---------------------------------------------------------
  // userinfo에 공백이 없으므로 후보는 "허용 문자만으로 이뤄진 최대 런" 안의 `@`들이다.
  // 런을 한 번만 구해 두면 후보마다 문자집합을 다시 훑지 않아도 된다(비용이 선형으로 남는다).
  let strictEnd = authorityStart;
  while (strictEnd < spanEnd && STRICT_USERINFO_RE.test(subject.charAt(strictEnd))) {
    strictEnd += 1;
  }
  for (let i = strictEnd - 1; i >= authorityStart; i -= 1) {
    if (subject.charAt(i) === "@" && hasHostAfter(subject, i, spanEnd)) return i;
  }

  // --- 관대 갈래 ---------------------------------------------------------
  // `:`가 없으면 자격증명으로 보지 않는다(F-19). 사용자명 단독은 비밀번호보다 민감도가 낮고
  // `mongodb://my user@host` 같은 형태를 산문과 구별할 근거가 없다.
  const colon = subject.indexOf(":", authorityStart);
  if (colon < 0 || colon >= spanEnd) return -1;

  // 비밀번호 후보 구간 `[colon+1, p)`가 "후행 트림 후 내부 공백 없음"을 만족하는 `p`는
  // **연속 범위**다: 첫 공백류 이전 전부, 그리고 그 공백류 런의 바로 끝.
  // `@`는 공백류가 아니므로 후보는 `[colon+1, firstSpace)` 안의 `@`들 + 공백 런 끝의 `@` 하나다.
  let firstSpace = colon + 1;
  while (firstSpace < spanEnd && !SPACE_RE.test(subject.charAt(firstSpace))) firstSpace += 1;
  let spaceRunEnd = firstSpace;
  while (spaceRunEnd < spanEnd && SPACE_RE.test(subject.charAt(spaceRunEnd))) spaceRunEnd += 1;

  // 뒤에서부터 — 후행 공백을 사이에 둔 `@`가 가장 오른쪽 후보다.
  if (
    spaceRunEnd > firstSpace &&
    spaceRunEnd < spanEnd &&
    subject.charAt(spaceRunEnd) === "@" &&
    hasHostAfter(subject, spaceRunEnd, spanEnd)
  ) {
    return spaceRunEnd;
  }
  for (let i = firstSpace - 1; i > colon; i -= 1) {
    if (subject.charAt(i) === "@" && hasHostAfter(subject, i, spanEnd)) return i;
  }
  return -1;
}

/** `mongodb://` · `mongodb+srv://` 스킴. 여기서 authority가 시작한다. */
const MONGO_SCHEME_RE = /\bmongodb(?:\+srv)?:\/\//gi;

const collectMongoCredentials: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(MONGO_SCHEME_RE)) {
    const scheme = match[0];
    if (scheme === undefined) continue;

    const authorityStart = matchIndex(match) + scheme.length;
    const userinfoEnd = findUserinfoEnd(probe, authorityStart);
    // `@`가 없으면 자격증명이 없는 URI다. `mongodb://localhost:27017/sentinel`은 그대로 둔다.
    if (userinfoEnd < 0) continue;

    const userinfo = probe.slice(authorityStart, userinfoEnd);
    const colon = userinfo.indexOf(":");
    // `:`이 없으면 사용자명만 있는 형태(`mongodb://svcuser@host`)다.
    const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
    const pass = colon < 0 ? undefined : userinfo.slice(colon + 1);

    const userStart = authorityStart;
    const userEnd = userStart + user.length;
    // 자리표시자 판정은 **후행 공백을 뺀** 값으로 한다. `<pass> @host`처럼 관대 갈래로 들어온
    // 자리표시자가 후행 공백 때문에 실제 값으로 오인되지 않게 한다.
    // 치환 구간은 그대로 후행 공백까지 삼킨다 — 자격증명 구간 안이라 남길 이유가 없다.
    const trimmedPass = pass?.trimEnd();
    const maskUser = user.length > 0 && !isPlaceholder(user);
    const maskPass = trimmedPass !== undefined && trimmedPass.length > 0 && !isPlaceholder(trimmedPass);

    if (maskUser && maskPass) {
      // 둘 다 실제 값이면 `user:pass` 전체를 라벨 하나로 합쳐 지운다.
      segments.push({ start: userStart, end: userinfoEnd, kind: "db-credentials" });
      continue;
    }
    if (maskUser) segments.push({ start: userStart, end: userEnd, kind: "db-credentials" });
    if (maskPass) segments.push({ start: userEnd + 1, end: userinfoEnd, kind: "db-credentials" });
  }
  return segments;
};

/**
 * `Authorization: Bearer <token>` 의 토큰부. 스킴 이름(`Bearer`)은 남긴다 —
 * "인증 헤더가 붙어 있었다"는 사실 자체가 진단 정보다.
 *
 * 꺾쇠로 감싼 토큰도 잡는다. `Bearer <eyJhbGci...>`는 문서 표기처럼 보이지만
 * 안에 실제 JWT가 들어 있는 경우가 많다. 오탐 방지는 문자 클래스가 아니라
 * `isPlaceholder`가 맡는다 — `Bearer <token>`은 자리표시자로 걸러지고
 * `Bearer xxx`·`Bearer ***`는 애초에 매치되지 않는다.
 *
 * 하한을 4자로 낮춘 것은 `Bearer aB3xY9z`(7자) 같은 짧은 실토큰을 놓치지 않기 위함이다.
 */
const BEARER_RE = /\b(Bearer[ \t]+)(<[^<>\s]{1,256}>|[A-Za-z0-9._~+/=-]{4,})/gi;

const collectBearerToken: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(BEARER_RE)) {
    const scheme = match[1];
    const token = match[2];
    if (scheme === undefined || token === undefined) continue;
    if (isPlaceholder(token)) continue;

    const start = matchIndex(match) + scheme.length;
    segments.push({ start, end: start + token.length, kind: "bearer-token" });
  }
  return segments;
};

/**
 * 문맥 앵커가 붙은 API 키. `ANTHROPIC_API_KEY=`, `api_key:`, `apiKey:` 등.
 *
 * **앵커가 있으면 값의 모양을 따지지 않는다.** AWS 시크릿 규칙이 이미 그렇게 하는데
 * API 키에만 그 대칭이 없어서 `ANTHROPIC_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCD`
 * (숫자 없는 본문)가 통째로 샜다. 키 이름이 붙어 있다는 것보다 강한 문맥 증거는 없다.
 * 값은 공백·따옴표·구분자 전까지 전부 삼켜 잔여물을 남기지 않는다.
 *
 * `ANTHROPIC_`·`VOYAGE_` 같은 접두사는 **소비하지 않고 룩비하인드로만 확인**한다.
 * `[A-Za-z0-9_.-]*api...`처럼 앞을 소비하게 쓰면 영숫자 런 100KB에서 시작 위치마다
 * 끝까지 훑어 O(n²)가 된다(실측 1.4초). 고정 문자열 `api`를 매치 시작점으로 두면 선형이다.
 */
const ANCHORED_API_KEY_RE = /(?<![A-Za-z0-9])(api[_-]?key\s*[:=]\s*["'`]?)([^\s"'`,;]{4,512})/gi;

const collectAnchoredApiKey: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(ANCHORED_API_KEY_RE)) {
    const anchor = match[1];
    const value = match[2];
    if (anchor === undefined || value === undefined) continue;
    if (isPlaceholder(value)) continue;

    const start = matchIndex(match) + anchor.length;
    segments.push({ start, end: start + value.length, kind: "api-key" });
  }
  return segments;
};

/**
 * 앵커 없이 떠 있는 `sk-`(OpenAI) · `sk-ant-`(Anthropic) · `pa-`(Voyage) 계열 API 키.
 *
 * 오탐 방지: 접두사만 보면 `sk-learn`, `pa-rser` 같은 평범한 하이픈 단어가 걸린다.
 * 그래서 접두사 뒤 본문에 **20자 이상**을 요구한다 — 이 하나로 충분하다.
 * 예전에는 "숫자 1개 이상"도 요구했는데, 그건 실제 발급 키의 성질이 아니라
 * 추측이었고 `sk-ant-api-AbCdEfGhIjKlMnOpQrStUvWxYz`처럼 숫자 없는 키를 그대로 흘렸다.
 * 20자 이상의 `sk-`/`pa-` 하이픈 단어는 자연어 산문에 사실상 등장하지 않는다.
 */
const BARE_API_KEY_RE = /(?<![A-Za-z0-9_-])(sk-ant-|sk-|pa-)([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g;

const collectBareApiKey: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(BARE_API_KEY_RE)) {
    const whole = match[0];
    if (whole === undefined) continue;
    const start = matchIndex(match);
    segments.push({ start, end: start + whole.length, kind: "api-key" });
  }
  return segments;
};

/**
 * AWS 액세스 키 ID. `AKIA`/`ASIA` + 정확히 16자 대문자·숫자.
 *
 * 오탐 방지: 앞뒤 `\b`와 "정확히 16자"가 방어선이다. "AKIA로 시작하는 키를 교체했다"의
 * `AKIA`나, AKIA를 포함한 더 긴 식별자는 길이가 맞지 않아 걸리지 않는다.
 */
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

const collectAwsAccessKey: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(AWS_ACCESS_KEY_RE)) {
    const whole = match[0];
    if (whole === undefined) continue;
    const start = matchIndex(match);
    segments.push({ start, end: start + whole.length, kind: "aws-access-key" });
  }
  return segments;
};

/**
 * AWS 시크릿 액세스 키 — 문맥 앵커가 있는 경우.
 * `aws_secret_access_key=...` 처럼 키 이름이 붙어 있으면 값의 모양을 따지지 않는다.
 *
 * `{40,}`로 **값의 끝까지** 삼킨다. `{40}`으로 끊으면 41자 값에서 마지막 한 글자가
 * `[MASKED:aws-secret-key]Z` 처럼 평문으로 남는다.
 */
const ANCHORED_AWS_SECRET_RE =
  /((?:aws[_-]?)?secret[_-]?access[_-]?key\s*[:=]\s*["'`]?)([A-Za-z0-9/+=]{40,})/gi;

const collectAnchoredAwsSecretKey: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(ANCHORED_AWS_SECRET_RE)) {
    const anchor = match[1];
    const value = match[2];
    if (anchor === undefined || value === undefined) continue;

    const start = matchIndex(match) + anchor.length;
    segments.push({ start, end: start + value.length, kind: "aws-secret-key" });
  }
  return segments;
};

/**
 * 문맥 앵커 없이 떠 있는 40자 base64류 문자열.
 *
 * 오탐 방지가 가장 어려운 규칙이다. `[A-Za-z0-9/+=]{40}`만 보면 **git SHA-1(40자 hex)**이
 * 통째로 걸린다 — 트러블슈팅 기록에 커밋 해시는 매 문단 등장한다.
 *
 * 예전에는 "소문자·대문자·숫자를 모두 포함"을 요구해 이를 우회했는데, 그 조건은
 * 목적(SHA 오탐 방지)의 **대리 지표**일 뿐이라 숫자 없는 40자 시크릿을 함께 흘렸다
 * (`(54/64)^40 ≈ 0.11%` — 영구 저장 기준 1000건에 1건). 목적을 직접 표현하면
 * 대리 지표가 필요 없다: **hex 문자만으로 이뤄진 40자는 SHA로 보고 건너뛴다.**
 * 그 외 40자 런은 전부 시크릿으로 본다.
 */
const STANDALONE_AWS_SECRET_RE = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;
const GIT_SHA1_RE = /^[0-9a-f]{40}$/i;

const collectStandaloneAwsSecretKey: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(STANDALONE_AWS_SECRET_RE)) {
    const whole = match[0];
    if (whole === undefined) continue;
    if (GIT_SHA1_RE.test(whole)) continue;

    const start = matchIndex(match);
    segments.push({ start, end: start + whole.length, kind: "aws-secret-key" });
  }
  return segments;
};

/**
 * 이메일. 기본 off — 담당자 이름은 대개 진단 정보라 옵트인으로 둔다(specs/03 §6).
 *
 * 모든 반복에 **상한**이 있어야 한다. `[A-Za-z0-9._%+-]+@`처럼 무한 반복을 쓰면
 * `@` 없는 긴 런에서 시작 위치마다 전체를 다시 훑어 O(n²)가 되고, 100KB 입력에서
 * 12초짜리 동기 블록이 생긴다 — 저장 API가 통째로 멈춘다.
 * 상한 64는 RFC 5321의 로컬파트 최대 길이, 63은 라벨 최대 길이다.
 */
const EMAIL_RE =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;

const collectEmail: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(EMAIL_RE)) {
    const whole = match[0];
    if (whole === undefined) continue;
    const start = matchIndex(match);
    segments.push({ start, end: start + whole.length, kind: "email" });
  }
  return segments;
};

/**
 * 규칙 적용 순서. 더 구체적인 규칙이 먼저 와야 라벨이 정확해진다.
 * 예: `Bearer sk-ant-...`는 bearer 규칙이 먼저 잡아 `bearer-token`으로 표시된다.
 * 앵커 규칙이 무앵커 규칙보다 앞이어야 문맥 판정이 살아난다.
 * 먼저 온 규칙의 구간과 겹치는 뒤 규칙의 구간은 버려진다.
 */
const MASK_RULES: readonly MaskRule[] = [
  collectMongoCredentials,
  collectBearerToken,
  collectAnchoredApiKey,
  collectBareApiKey,
  collectAwsAccessKey,
  collectAnchoredAwsSecretKey,
  collectStandaloneAwsSecretKey,
];

// ---------------------------------------------------------------------------
// 적용
// ---------------------------------------------------------------------------

interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly kind: MaskKind;
}

function overlaps(a: MaskSegment, b: MaskSegment): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 프로브 구간을 원문 구간으로 되돌린다.
 *
 * 끝은 매치 마지막 문자가 유래한 **원문 문자의 끝**까지 잡는다. 한 원문 문자가
 * 여러 프로브 문자로 늘어난 경우 그 문자를 반쪽만 남기지 않기 위함이다.
 * 그다음 뒤따르는 제로폭 문자를 흡수한다 — 흡수하지 않으면 `AKIA...<ZWSP>` 처럼
 * 시크릿 꼬리에 붙은 비가시 문자가 라벨 뒤에 잔여물로 남는다.
 */
function toSourceEdit(segment: MaskSegment, text: string, probe: NormalizedProbe): SourceEdit {
  const start = probe.srcStart[segment.start] ?? text.length;
  let end = probe.srcEnd[segment.end - 1] ?? text.length;
  while (end < text.length) {
    // 코드유닛이 아니라 **코드포인트**로 읽는다 — tag 문자(U+E0000~)는 서로게이트 쌍이라
    // 반쪽만 보면 비가시 판정이 빗나가고 잔여물이 남는다.
    const cp = text.codePointAt(end);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    if (!isIgnorable(ch)) break;
    end += ch.length;
  }
  return { start, end, kind: segment.kind };
}

/** 시크릿을 라벨로 치환한다. `maskEmailEnabled`가 true면 이메일 규칙을 마지막에 덧붙인다. */
export function applyMasking(text: string, maskEmailEnabled: boolean): MaskingResult {
  if (text.length === 0) return { text, masked: [] };

  const probe = normalizeWithMap(text);
  const rules = maskEmailEnabled ? [...MASK_RULES, collectEmail] : MASK_RULES;

  // 1. **두 좌표계 모두**에서 구간을 모아 합집합을 취한다.
  //
  //    프로브만 보면 안 되는 이유: 프로브는 비가시 문자를 *삭제*하므로 시크릿 **경계**에
  //    있던 비가시 문자가 옆 토큰을 시크릿에 붙여버려 `\b` 앵커가 깨진다.
  //    `AKIAIOSFODNN7EXAMPLE<ZWSP>x` 가 프로브에서는 `AKIAIOSFODNN7EXAMPLEx`가 되어
  //    아무 규칙에도 안 걸린다 — 제로폭 1개는 인젝션 임계값 이하라 플래그도 안 붙는다.
  //    원문만 보면 반대로 시크릿 **내부** 삽입(`AKIA<ZWSP>IOSFO...`)을 놓친다.
  //    둘 다 돌려 합쳐야 양쪽이 닫힌다. (T-004 N-1)
  const probeEdits = collectEdits(rules, probe.probe).map((segment) =>
    toSourceEdit(segment, text, probe),
  );
  const rawEdits = collectEdits(rules, text).map((segment) => ({
    start: segment.start,
    end: segment.end,
    kind: segment.kind,
  }));

  // 겹치면 **더 넓은 구간**을 남긴다 — 좁은 쪽을 택하면 시크릿 일부가 평문으로 남는다.
  const edits = mergeSourceEdits([...probeEdits, ...rawEdits]);
  if (edits.length === 0) return { text, masked: [] };

  // 3. 제로폭 흡수가 인접 구간을 침범할 수 있으므로 앞 구간의 끝으로 클램프한다.
  const disjoint: SourceEdit[] = [];
  let cursor = 0;
  for (const edit of edits) {
    const start = Math.max(edit.start, cursor);
    if (start >= edit.end) continue;
    disjoint.push({ start, end: edit.end, kind: edit.kind });
    cursor = edit.end;
  }

  // 4. 뒤에서 앞으로 치환해 오프셋이 밀리지 않게 한다.
  const hits = new Set<MaskKind>();
  let out = text;
  for (let i = disjoint.length - 1; i >= 0; i -= 1) {
    const edit = disjoint[i];
    if (edit === undefined) continue;
    out = `${out.slice(0, edit.start)}${maskLabel(edit.kind)}${out.slice(edit.end)}`;
    hits.add(edit.kind);
  }

  return {
    text: out,
    masked: MASK_KINDS.filter((kind) => hits.has(kind)),
  };
}

/**
 * 한 좌표계에서 규칙을 돌려 겹치지 않는 구간을 모은다. 앞선 규칙이 이긴다.
 *
 * `chosen.some` 전수 비교라 세그먼트 수에 **이차**다(T-004 F-11). 이 곡선은 알고리즘이 아니라
 * `SANITIZE_MAX_INPUT_CHARS` 상한으로 막는다 — 상한 안에서는 최악(`Bearer ` 런 64KB)이
 * 58ms로 측정됐고, 상한을 크게 올리면 다시 초 단위로 튄다(T-004 결정 4).
 */
function collectEdits(rules: readonly MaskRule[], subject: string): MaskSegment[] {
  const chosen: MaskSegment[] = [];
  for (const rule of rules) {
    for (const segment of rule(subject)) {
      if (segment.end <= segment.start) continue;

      // 겹치면 **버리지 말고 확장한다.** 버리면 앞 규칙이 뒤 규칙의 시크릿을 앞부분만 덮었을 때
      // 뒤 규칙 세그먼트가 통째로 폐기되고 **꼬리가 평문으로 남는다** —
      // 과마스킹이 유출로 전환되는 경로다(T-004 N-12).
      // 예: mongo 규칙이 `?api_key=tok`까지 삼키면 api-key 세그먼트가 버려져 값 꼬리가 남는다.
      const hit = chosen.findIndex((taken) => overlaps(taken, segment));
      if (hit >= 0) {
        const taken = chosen[hit];
        if (taken !== undefined) {
          chosen[hit] = {
            start: Math.min(taken.start, segment.start),
            end: Math.max(taken.end, segment.end),
            kind: taken.kind, // 라벨은 먼저 잡은 규칙(우선순위가 높은 쪽)의 것을 쓴다
          };
        }
        continue;
      }
      chosen.push(segment);
    }
  }
  return chosen;
}

/**
 * 두 좌표계에서 온 구간을 합친다. 시작 오름차순 → 길이 내림차순으로 정렬해
 * 포함되는 구간을 버리고, 부분 겹침이면 뒤쪽 끝까지 넓힌다.
 *
 * **확장 분기(`edit.end > last.end`)는 방어적이다.** 실측상 유닛·공격·오탐 코퍼스
 * 127종 어디에서도 발화하지 않는다(T-004 F-16) — 두 좌표계의 매치는 같은 시작점에서
 * 한쪽이 다른 쪽을 포함하는 형태로만 겹치기 때문이다. 부분 겹침을 만드는 입력을 아직
 * 찾지 못했다는 뜻이지 불가능하다는 증명은 아니므로, 값싼 방어를 남겨 둔다.
 * **커버리지가 없다는 사실 자체를 여기 적어 두는 것이 요점이다** — 테스트가 지키지 않는
 * 코드를 "지켜지고 있다"고 오해하면 T-004에서 두 번 반복한 가짜 커버리지가 또 생긴다.
 */
function mergeSourceEdits(edits: readonly SourceEdit[]): SourceEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SourceEdit[] = [];
  for (const edit of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && edit.start < last.end) {
      if (edit.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: edit.end, kind: last.kind };
      }
      continue;
    }
    merged.push({ ...edit });
  }
  return merged;
}

/** NFKD로 분해된 문자열에서 결합 표시를 뺀다. 프로브 전용 — 원문은 건드리지 않는다. */
function stripMarks(decomposed: string): string {
  let out = "";
  for (const char of decomposed) {
    if (!isIgnorable(char)) out += char;
  }
  return out;
}
