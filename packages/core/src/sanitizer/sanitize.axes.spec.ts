/**
 * T-004 문법 위치별 전수 스윕. 출처: `docs/analysis/T-004-POSTMORTEM.md` §1.1·§4.2.
 *
 * ## 이 파일이 존재하는 이유
 *
 * mongo 자격증명 마스킹은 **여덟 라운드** 동안 같은 실패를 반복했다. 매 라운드가 판정자를
 * 바꿨고(제로폭 목록 → userinfo 문자집합 → 호스트 룩어헤드 → authority 종결자 → 호스트 모양 →
 * strict 집합 → 갈래 진입 조건), 매 라운드가 **옆칸을 열었다.** 판정 방식이 "열거"인 한
 * 열거 밖 문자는 규칙을 무발동시키고, 무발동은 **무플래그 평문 통과**(fail-open)였기 때문이다.
 *
 * 반복의 직접 원인은 **테스트 축을 직전에 지적받은 자리에서 골랐다**는 것이다(포스트모템 §2.3).
 * 6·7·8차의 대역 스윕 표 세 개는 전부 "직전 라운드가 열린 자리"를 기저로 삼았고,
 * 그래서 원리적으로 한 칸씩만 옆으로 움직였다:
 *
 * | 표  | 기저 입력                  | 훑은 축         | 놓친 자리                |
 * | --- | -------------------------- | --------------- | ------------------------ |
 * | 6차 | `…:Str0ngPass{C}x@host…`   | 비밀번호 안     | 호스트 뒤                |
 * | 7차 | `…:Str0ngPass@host{C}`     | 호스트 뒤       | 비번 안 `@` 뒤           |
 * | 8차 | `…:P@ssw0rd{C}…@host…`     | 비번 안 `@` 뒤  | **`:` 없는 사용자명 안** |
 *
 * 축을 고르는 옳은 방법은 실패의 좌표가 아니라 **입력 문법의 구조**다. mongodb URI의 문법 위치는
 * `scheme / user / [":" pass] / "@" / host / [":" port] / path / query`이고, 축은 그 **위치의
 * 개수**만큼 있다. 세 표는 그중 3개만 덮었다. 이 파일은 **6개 위치를 한꺼번에** 훑는다.
 *
 * ## 축만으로는 부족했다 — 기저도 축이다
 *
 * 이 파일의 첫 판은 6축 × 94자를 전부 훑고도 **N-14(93/94)를 0/94로 보고했다.** 기저가
 * `@cluster0.example.net/db` 한 종류였고 거기엔 **포트가 없었기** 때문이다. `:`가 포트나
 * 쿼리에도 나타난다는 구조를 기저가 담지 못하면, 94자를 아무리 훑어도 그 대역은 보이지 않는다.
 * 그래서 각 축을 **기저 변형(`TAILS`)별로** 돌린다 — 축 6개 × 기저 5개 × 94자.
 * **전수 스윕조차 기저 선택에 종속된다**는 것이 이 파일이 비싸게 배운 교훈이다.
 *
 * ## 규약
 *
 * - 판정은 열거가 아니라 **외부 기준**으로 잠근다: ASCII 인쇄 가능 94자(0x21–0x7E) 전수.
 *   어느 문자가 어느 문법 위치에 오든 자격증명은 마스킹돼야 한다. 문자를 **줄이지 마라** —
 *   94자 전수가 이 파일의 존재 이유다. 느리면 케이스를 쪼개지 말고 축 하나로 묶어라.
 * - **기저 변형도 줄이지 마라.** 위 문단이 그 이유다.
 * - **축별로** 유출 0을 단언한다. 합계만 보면 어느 축이 열렸는지 알 수 없다.
 * - 유출 = 자격증명 꼬리 마커가 출력에 **생존**. 플래그만 붙고 값이 남는 것도 유출이다(N-12는
 *   `flags=["secret-masked"]`가 붙은 채 비밀번호가 남았다 — "새니타이즈됨"으로 보이는 유출).
 *
 * 픽스처의 자격증명은 전부 **가짜**다. 마커(`Zx9Qtail`)로 유효한 값이 아님을 눈으로 알 수 있게 했다.
 */
import { describe, expect, it } from "vitest";

import { sanitize } from "./sanitize.js";

/**
 * 자격증명 꼬리 마커. 이 문자열이 출력에 남으면 유출이다.
 * 각 축은 `{C}` **뒤에** 마커를 두어, 경계 판정이 `{C}`에서 잘못 끊기면 마커가 살아남게 만든다.
 */
const MARK = "Zx9Qtail";

/**
 * ASCII 인쇄 가능 94자 = `0x21`–`0x7E`. 공백(`0x20`)은 뺀다 —
 * 공백은 **면제 조건**(자격증명 자리의 내부 공백류 = 산문)이라 다른 축이고,
 * 그 대역의 한계는 포스트모템 §4.4①(F-18/F-21)에 별도로 기록돼 있다.
 */
const ASCII94 = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i));

/**
 * **기저 변형.** 축을 94자로 훑는 것만으로는 부족하다 — 훑는 **기저**가 한 종류면
 * 그 기저에 없는 구조는 영영 보이지 않는다.
 *
 * 이걸 실패로 배웠다. 이 파일의 첫 판은 기저가 `@cluster0.example.net/db` 하나였고,
 * 6축 × 94자를 전부 훑고도 **N-14를 0/94로 보고했다.** 실제로는 93/94였다.
 * 잡아낸 것은 스윕이 아니라 우연히 적은 이름 붙인 케이스 하나(`@mongo:27017`)였다.
 * 전수 스윕조차 기저 선택에 종속된다 — 포스트모템 §3.2가 "생성기가 문법 위치별로
 * 값을 뽑아야 한다"고 한 이유가 이것이다.
 *
 * 그래서 각 축을 **기저 변형별로** 돌린다. 변형의 축은 "URI 문법에서 `:`가 나타날 수 있는
 * 다른 위치"다 — 포트와 쿼리. N-14는 정확히 그 위치에 숨어 있었다.
 * **변형을 줄이지 마라.** 줄이는 순간 그만큼 눈이 먼다.
 */
const TAILS: readonly [label: string, tail: string][] = [
  ["점O 포트X", "@cluster0.example.net/db"],
  ["점O 포트O", "@cluster0.example.net:27017/db"],
  ["점X 포트X", "@mongo/db"],
  ["점X 포트O", "@mongo:27017/db"],
  ["쿼리 콜론", "@cluster0.example.net/db?t=a:b"],
];

/** `{C}`와 기저 변형을 받아 입력 한 줄을 만드는 축 정의. */
type AxisBuilder = (char: string, tail: string) => string;

/** 유출 1건의 좌표. 어느 기저에서 어느 문자가 샜는지까지 남긴다. */
interface Leak {
  readonly tail: string;
  readonly char: string;
}

/**
 * 한 축을 **기저 변형 × 94자** 전수로 훑고 **유출 목록**을 돌려준다.
 *
 * 개수가 아니라 목록을 돌려주는 이유는 실패 메시지 때문이다. "3건 유출"보다
 * `[{tail:"점X 포트O", char:"#"}]`가 다음 사람에게 훨씬 많은 것을 알려준다.
 */
function sweepAxis(build: AxisBuilder): { leaked: Leak[]; unflagged: Leak[] } {
  const leaked: Leak[] = [];
  const unflagged: Leak[] = [];

  for (const [label, tail] of TAILS) {
    for (const char of ASCII94) {
      const { text, flags } = sanitize(build(char, tail), { maskEmail: false });
      if (text.includes(MARK)) leaked.push({ tail: label, char });
      else if (!flags.includes("secret-masked")) unflagged.push({ tail: label, char });
    }
  }
  return { leaked, unflagged };
}

describe("sanitize — URI 문법 위치별 전수 스윕 (T-004 포스트모템 §4.2)", () => {
  /**
   * 축1 — 비밀번호 **안**의 문자. 6차 표(`sanitize.spec.ts`)가 덮은 축이다.
   * N-10이 살던 자리: authority 종료 문자(`/`·`?`)가 비밀번호 안에 있으면 파서가 거기서
   * authority를 끊어 `@`를 못 찾고 자격증명 전체가 평문 통과했다.
   */
  it("축1 — 비밀번호 안의 문자 94자 전수: 유출 0", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://appuser:Str0ng${c}${MARK}${t}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  /**
   * 축2 — 호스트 **뒤**의 문자. 7차 표가 덮은 축이다.
   * N-11이 살던 자리: 호스트 "모양" 열거 밖 문자(마크다운 백틱·한국어 마침표·레플리카셋 쉼표·
   * `$PORT` 보간)가 오면 호스트로 인정되지 않아 규칙이 무발동했다. 94자 중 25자가 샜다.
   */
  it("축2 — 호스트 뒤의 문자 94자 전수: 유출 0", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://appuser:Str0ng${MARK}${t}${c}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  /**
   * 축3 — 비밀번호 안 **`@` 뒤**의 문자. 8차 표가 덮은 축이다.
   * N-12가 살던 자리: strict 런이 집합 밖 문자에서 끊겨 **비밀번호 내부의 `@`가 경계로 뽑히고**
   * 나머지 비밀번호가 평문으로 남았다. `flags`에는 `secret-masked`가 붙었다 —
   * **"새니타이즈됨"으로 보이는데 비밀번호가 들어 있는** 최악의 형태다.
   * 그래서 이 축의 기저 비밀번호는 **반드시 `@`를 포함한다.**
   */
  it("축3 — 비밀번호 안 `@` 뒤의 문자 94자 전수: 유출 0", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://appuser:P@ss${c}${MARK}${t}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  /**
   * 축4 — **`:` 없는 사용자명 안**의 문자. **이 축이 이 파일의 이유다.**
   *
   * 포스트모템 §1.1: *"어느 라운드의 스윕 테이블도 이 축을 덮지 않았다."*
   * 여덟 라운드·세 개의 스윕 표를 지나는 동안 **한 번도 관측되지 않은 축**이고,
   * 처음 측정했을 때 **94자 중 93자가 유출**이었다(유일한 예외가 `:` — 그게 들어가면
   * 관대 갈래가 켜져서다). 8차의 수정이 만든 자리다: strict는 `@`를 절대 못 찾게 됐고
   * lenient는 `:`를 필수로 요구해, `:` 없는 userinfo가 **어느 갈래에도 걸리지 않았다.**
   *
   * 실제 유출 형태는 추상적이지 않다 — `mongodb://<apikey>@host`(토큰을 사용자명 자리에)와
   * `mongodb+srv://ops.corp.com@host`(Atlas의 이메일형 사용자명)가 이 대역이다.
   * 둘 다 **무플래그 평문 통과**였다.
   *
   * **이 테스트를 지우거나 좁히려는 사람에게:** 여기서 93/94를 0/94로 만든 것은
   * 갈래를 늘린 게 아니라 판정을 fail-open에서 fail-closed로 **뒤집은 것**이다
   * (`masking.ts`의 `findUserinfoEnd` — 엄격 갈래와 `:` 필수 요구를 통째로 삭제).
   * 이 축이 다시 열리면 여덟 라운드가 아홉 번째로 반복되는 것이다.
   */
  it("축4 — `:` 없는 사용자명 안의 문자 94자 전수: 유출 0 (before: 93/94 — 어느 표도 덮지 않던 축)", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://tok${c}enng${MARK}${t}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  /**
   * 축5 — 스킴 **직후**의 문자. 어느 라운드도 훑지 않은 축이다.
   * 기저에 `:`가 없으므로 축4와 같은 fail-open 대역에 있었고, 실측 before도 **93/94**였다.
   */
  it("축5 — 스킴 직후의 문자 94자 전수: 유출 0 (before: 93/94)", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://${c}token${MARK}${t}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  /** 축6 — `:` **있는** 사용자명 안의 문자. 어느 라운드도 훑지 않았으나 before부터 0/94였다. */
  it("축6 — `:` 있는 사용자명 안의 문자 94자 전수: 유출 0", () => {
    const { leaked, unflagged } = sweepAxis((c, t) => `mongodb://tok${c}enn:Str0ng${MARK}${t}`);

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });
});

/**
 * N-13의 대표 케이스. 축4의 스윕이 대역 전체를 잠그지만, **이름이 붙은 케이스**도 남긴다 —
 * 스윕이 실패하면 "94자 중 어느 문자"가 나오고, 이쪽이 실패하면 "무엇이 샜는지"가 바로 보인다.
 */
describe("sanitize — `:` 없는 자격증명 (T-004 N-13)", () => {
  it.each([
    [
      "토큰을 사용자명 자리에",
      "mongodb://tokenonly_abcdef123456@cluster0.example.net/db",
      "mongodb://[MASKED:db-credentials]@cluster0.example.net/db",
    ],
    [
      "Atlas 이메일형 사용자명",
      "mongodb+srv://ops.corp.com@cluster0.example.net/db",
      "mongodb+srv://[MASKED:db-credentials]@cluster0.example.net/db",
    ],
    [
      "compose 서비스명 호스트",
      "mongodb://apikeyAbcdef123456@mongo/db",
      "mongodb://[MASKED:db-credentials]@mongo/db",
    ],
  ])("%s — 마스킹하고 호스트는 남긴다", (_name, input, expected) => {
    const { text, flags } = sanitize(input, { maskEmail: false });

    // 완전 일치라 "일부만 지운" 뮤턴트도 살아남지 못한다.
    // 호스트·포트·DB명은 진단 정보이므로 남아야 한다 — 삼키면 그건 F-15다.
    expect(text).toBe(expected);
    expect(flags).toContain("secret-masked");
  });

  /**
   * 자격증명 자리에 **첫 `:`가 다음 줄에 있는** 형태.
   *
   * 이력: 포스트모템 §4.1의 문언을 글자 그대로(`credStart = colon >= 0 ? colon+1 : authorityStart`)
   * 옮기면 여기서 새 fail-open이 생겼다 — `colon`이 스팬(줄 끝) 밖을 가리켜 후보 구간이 비었다.
   * 그래서 `colon < spanEnd` 클램프를 뒀다.
   *
   * **다만 N-14 수정 이후 그 클램프는 중복(redundant)이다** — 뮤테이션으로 확인했다.
   * 클램프를 지워도 행동이 바뀌지 않는다(등가 뮤턴트): `\s`가 개행도 포함하므로 스캔이 개행에서
   * 멈추고, 스팬 밖 후보는 `hasHostAfter`가 거른다. 클램프는 의도를 드러내는 방어선으로 남겼다.
   * **이 테스트가 잠그는 것은 클램프가 아니라 동작 자체**이고, 그 값어치는 그대로다.
   */
  it("첫 `:`가 다음 줄에 있어도 같은 줄의 자격증명을 지운다", () => {
    const { text, flags } = sanitize(
      `mongodb://tokenonly_abcdef123456@cluster0.example.net/db\n재현: 접속 직후 실패`,
      { maskEmail: false },
    );

    expect(text).not.toContain("tokenonly_abcdef123456");
    expect(flags).toContain("secret-masked");
  });
});

/**
 * ## N-14 — `:` 없는 사용자명 + **경계보다 오른쪽에 있는 `:`**
 *
 * 포스트모템 §6은 "축4 외 미탐색 축(**포트 자리**·쿼리스트링·`+srv` 특유 형태)의 현행 유출률"을
 * **미검증**으로 남겼다. 그 축을 훑었더니 N-13과 **같은 크기(93/94)의 fail-open**이 나왔다.
 * 8차 원본(`HEAD~1`)에서도 동일하게 샜으므로 **어느 수정의 회귀도 아니고**, 여덟 라운드 내내
 * 열려 있던 자리다. 첫 fail-closed 수정은 `:`가 스팬에 **아예 없는** 부분집합만 닫았다
 * (`@mongo/db`는 닫혔고 `@mongo:27017/db`는 안 닫혔다).
 *
 * **원인:** `findUserinfoEnd`가 `indexOf(":", authorityStart)`로 **줄 전체**에서 첫 `:`를 찾았다.
 * 사용자명에 `:`가 없으면 그 `:`는 **호스트의 포트 콜론**(`@mongo:27017`)이나 **쿼리의 콜론**
 * (`?t=a:b`)이고, `credStart`가 경계 `@`를 **지나쳐 버려** 오른쪽에 `@`가 남지 않는다 →
 * 무발동 → **무플래그 평문 통과.** 불변식("자격증명 자리 = 첫 `:` 이후")의 "첫 `:`"를
 * **userinfo 안이 아니라 줄 전체**에서 읽은 것이 결함이었다.
 *
 * **수정:** 탐색 **범위를 좁혔다.** `:`는 경계 후보보다 왼쪽에서만 유효하므로,
 * 첫 `:`를 기준으로 경계가 있을 수 있는 두 자리(오른쪽/왼쪽)를 같은 술어로 본다.
 * 포트·쿼리 문자를 특별 취급하는 코드는 **없다** — 판정에 쓰는 문자 집합은 여전히 `\s` 하나다.
 */
describe("sanitize — `:` 없는 사용자명 + 경계 뒤의 `:` (T-004 N-14)", () => {
  it.each([
    [
      "포트 있는 호스트",
      "mongodb://apikeyAbcdef123456@mongo:27017/db",
      "mongodb://[MASKED:db-credentials]@mongo:27017/db",
    ],
    [
      "FQDN + 포트",
      "mongodb://tokenonly_abcdef123456@cluster0.example.net:27017/db",
      "mongodb://[MASKED:db-credentials]@cluster0.example.net:27017/db",
    ],
    [
      "Atlas 이메일형 + 포트",
      "mongodb+srv://ops.corp.com@cluster0.example.net:27017/db",
      "mongodb+srv://[MASKED:db-credentials]@cluster0.example.net:27017/db",
    ],
    [
      "쿼리스트링 안의 콜론",
      "mongodb://apikeyAbcdef123456@mongo/db?t=a:b",
      "mongodb://[MASKED:db-credentials]@mongo/db?t=a:b",
    ],
  ])("%s — 마스킹하고 포트·쿼리는 남긴다", (_name, input, expected) => {
    const { text, flags } = sanitize(input, { maskEmail: false });

    expect(text).toBe(expected);
    expect(flags).toContain("secret-masked");
  });
});

/**
 * N-14와 **같은 문법 위치인데 처음부터 닫혀 있던** 축. `user:pass`가 있으면 첫 `:`가 경계
 * 왼쪽이라 `credStart`가 원래 올바르게 잡혔다 — 즉 N-14는 포트·쿼리 자체의 문제가 아니라
 * **`:` 없는 사용자명과의 조합**에서만 열렸다. 이 두 축이 그 경계를 고정한다.
 */
describe("sanitize — 포트·쿼리 자리 전수 (T-004 포스트모템 §6 미탐색 축)", () => {
  it("축8 — 포트 자리 문자 94자 전수 (user:pass 있음): 유출 0", () => {
    const { leaked, unflagged } = sweepAxis(
      (c, t) => `mongodb://appuser:Str0ng${MARK}${t.replace("27017", `2${c}7017`)}`,
    );

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });

  it("축9 — 쿼리스트링 문자 94자 전수 (user:pass 있음): 유출 0", () => {
    const { leaked, unflagged } = sweepAxis(
      (c, t) => `mongodb://appuser:Str0ng${MARK}${t}?opt=${c}v`,
    );

    expect(leaked).toEqual([]);
    expect(unflagged).toEqual([]);
  });
});

/**
 * 오탐 축 — **FR-06이 FR-01을 잡아먹지 않는지** 본다(R-8).
 *
 * fail-closed로 뒤집으면 실수의 대가가 유출에서 오탐으로 바뀐다. 그 방향이 옳지만
 * (위험 비대칭: 미탐 > 오탐), 정상 산문의 호스트가 지워지면 그건 F-15의 재발이고
 * **진단 정보의 소실**이다. 마스킹 규칙을 조일 때 이쪽이 함께 깨지지 않는지 확인한다.
 */
describe("sanitize — 정상 산문·URI를 건드리지 않는다 (T-004 F-15 / R-8)", () => {
  it.each([
    ["산문 속 호스트 + 멘션", "mongodb://localhost:27017 에서 실패, @team 에 공유했다."],
    ["산문 + 이메일", "mongodb://mongo 로그를 봤더니 sre@example.com 이 보냈다."],
    ["산문 + @here", "mongodb://localhost 접속이 안 된다. @here 확인 바람."],
    ["자격증명 없는 URI", "mongodb://localhost:27017/sentinel"],
    ["자격증명 없는 SRV", "mongodb+srv://cluster0.example.net/sentinel?retryWrites=true"],
    ["compose 서비스명", "mongodb://mongo:27017/sentinel 로 붙는다."],
    ["레플리카셋 + 멘션", "mongodb://mongo1:27017,mongo2:27017/db 레플리카셋. @oncall 확인."],
    ["에러 로그", "MongoServerError: connect ECONNREFUSED mongodb://127.0.0.1:27017"],
    ["미보간 env", "MONGO_URL=mongodb://${MONGO_HOST}:27017/db"],
  ])("%s — 원문 그대로 통과한다", (_name, input) => {
    const { text, flags } = sanitize(input, { maskEmail: false });

    expect(text).toBe(input);
    expect(flags).not.toContain("secret-masked");
  });
});
