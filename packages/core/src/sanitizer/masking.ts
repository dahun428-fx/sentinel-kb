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
 */
// 문자 클래스에서 공백을 빼면 `<db user name>:realpw@host` 처럼 한쪽에 공백이 든 순간
// 규칙 전체가 무발동해 **비밀번호까지 통과한다**(T-004 N-3). 개행만 배제하고 길이를 묶는다.
//
// 공백을 허용한 대가로 `mongodb://localhost:27017 에서 실패, @team 에 공유` 같은 정상
// 문장이 128자까지 삼켜져 **보존을 약속한 호스트가 지워진다**(T-004 F-15, 알려진 오탐).
//
// 호스트 룩어헤드로 그 오탐을 막아 봤지만 **점 없는 호스트에서 비밀번호가 새는 회귀**가
// 생겼다(T-004 N-8). `mongodb://root:example@mongo` 는 compose 서비스명이라 `.`·`:`·`/`가
// 없다 — specs/06이 compose를 쓰므로 이 레포에서 가장 흔한 형태다.
// 룩어헤드 변형 3종을 실측한 결과 **미탐과 오탐 중 하나만 고를 수 있었다.**
// 시크릿 새니타이저의 위험 비대칭(미탐 > 오탐)에 따라 오탐 쪽을 택해 룩어헤드를 뺐다.
// 근본 해결은 문자 클래스가 아니라 **URI 구조 파싱**이다 — T-004 BLOCKED 항목 1.
const MONGO_URI_RE =
  /\b(mongodb(?:\+srv)?:\/\/)([^:/@\n]{1,128}):([^/@\n]{1,128})@/gi;

const collectMongoCredentials: MaskRule = (probe) => {
  const segments: MaskSegment[] = [];
  for (const match of probe.matchAll(MONGO_URI_RE)) {
    const scheme = match[1];
    const user = match[2];
    const pass = match[3];
    if (scheme === undefined || user === undefined || pass === undefined) continue;

    const userStart = matchIndex(match) + scheme.length;
    const userEnd = userStart + user.length;
    const passStart = userEnd + 1;
    const passEnd = passStart + pass.length;

    const maskUser = !isPlaceholder(user);
    const maskPass = !isPlaceholder(pass);

    if (maskUser && maskPass) {
      segments.push({ start: userStart, end: passEnd, kind: "db-credentials" });
      continue;
    }
    if (maskUser) segments.push({ start: userStart, end: userEnd, kind: "db-credentials" });
    if (maskPass) segments.push({ start: passStart, end: passEnd, kind: "db-credentials" });
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

/** 한 좌표계에서 규칙을 돌려 겹치지 않는 구간을 모은다. 앞선 규칙이 이긴다. */
function collectEdits(rules: readonly MaskRule[], subject: string): MaskSegment[] {
  const chosen: MaskSegment[] = [];
  for (const rule of rules) {
    for (const segment of rule(subject)) {
      if (segment.end <= segment.start) continue;
      if (chosen.some((taken) => overlaps(taken, segment))) continue;
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
