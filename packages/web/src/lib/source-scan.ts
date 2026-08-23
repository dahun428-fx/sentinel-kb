/**
 * 소스 스캔 헬퍼 — **테스트 전용**이다. 앱 코드는 이 모듈을 import하지 않는다.
 *
 * ## 왜 있는가
 * `client-safety.spec.ts`가 "소스를 훑어 위험한 경로 자체를 막는다"는 방식을 세웠고,
 * T-033의 `articles-safety.spec.ts`가 같은 방식을 쓴다. 그 스캐너의 핵심은 **주석을 지우고
 * 문자열은 남기는 것**이다 — 규칙을 설명하는 주석이 규칙 위반으로 잡히면, 다음 사람은
 * 검사를 무력화하거나 설명을 지운다(그 근거는 `client-safety.spec.ts`에 적혀 있다).
 *
 * 그 함수는 지금 `client-safety.spec.ts` 안에 있다. 스펙 파일을 다른 스펙 파일에서 import하면
 * 그쪽 `describe`가 이쪽 수집기에 등록되어 **같은 테스트가 두 번 돈다**. 그래서 여기에
 * 독립 구현을 둔다. 두 구현을 하나로 합치는 것은 남의 테스트 파일을 고치는 일이라
 * 이 태스크의 범위 밖이다 — Findings에 남긴다.
 */

/**
 * 주석을 지우고 문자열 리터럴은 남긴다.
 *
 * 문자열 안의 `//`(URL 등)를 주석으로 오해하지 않도록 인용 상태를 추적한다.
 * 정규식 리터럴은 추적하지 않는다 — 이 레포의 소스에 `/*`·`//`로 시작하는 정규식이 없고,
 * 있으면 스캔이 **더 많이 지우는** 쪽으로 틀려 오탐이 아니라 누락이 된다는 점은 알고 있다.
 */
export function stripSourceComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}
