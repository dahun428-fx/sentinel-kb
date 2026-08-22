/**
 * 질의를 **한국어 서술형**과 **식별자**로 가른다. 출처: T-013 Findings(T-010 F-6 인계).
 *
 * ## 왜 나누는가
 * `text_idx`의 분석기는 `lucene.standard`이고 **한국어 형태소 분석을 하지 않는다.**
 * "스트리밍이"가 통째로 한 토큰이라 질의 "스트리밍"과 매칭되지 않는다. 반면 영문·식별자
 * (`nginx`, `proxy_buffering`, `E11000`, 스택트레이스)는 잘 걸린다.
 *
 * 두 종류를 **하나의 Recall@5로 뭉치면 어느 경로가 무너졌는지 알 수 없다.** 텍스트 경로가
 * 한국어에서 0에 가깝고 벡터 경로가 그것을 가리고 있어도 합산 지표는 멀쩡해 보인다.
 * `specs/02`의 분석기를 `lucene.cjk`/nori로 바꿀지 판단하려면 **분해된 수치**가 있어야 한다.
 *
 * ## 분류 규칙 (질의 텍스트에서 유도한다)
 * `eval_cases` 스키마(`specs/02`)에는 질의 종류를 담을 필드가 없다. `.strict()`라 필드를
 * 추가하는 것은 contracts 개정 = 인간 승인이다. 그래서 **질의 문자열 자체에서 유도한다** —
 * 순수 함수라 단위 테스트로 잠글 수 있고, 골든셋 데이터를 건드리지 않는다.
 *
 * 규칙은 "**lucene.standard가 이 질의에서 쓸 만한 토큰을 뽑아낼 수 있는가**"다:
 *  - 공백으로 끊은 토큰 중 하나라도 **순수 ASCII 인쇄 가능 문자**이고 그 안에 영숫자가
 *    2자 이상 연속하면 → `identifier`. `502`, `nginx`, `proxy_buffering`, `ECONNREFUSED`가 여기다.
 *  - 그런 토큰이 없고 한글이 있으면 → `korean-prose`. 텍스트 경로가 사실상 기여하지 못하는 쪽이다.
 *  - 둘 다 아니면 → `other`(집계에서 따로 보이게 남겨 둔다. 조용히 한쪽에 섞지 않는다).
 *
 * **혼합 질의("nginx 502 왜 나?")는 `identifier`다.** 의도한 것이다 — 텍스트 경로가 붙잡을
 * ASCII 토큰이 하나라도 있으면 그 질의는 "한국어라서 텍스트 경로가 죽는" 사례가 아니다.
 * 분석기 교체의 근거가 되는 것은 **붙잡을 것이 아무것도 없는** 질의들이다.
 */

export const QUERY_KINDS = ["identifier", "korean-prose", "other"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/** 한글 음절 + 자모 + 호환 자모. */
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** 순수 ASCII 인쇄 가능 문자만으로 이루어진 토큰. */
const ASCII_TOKEN = /^[!-~]+$/;

/**
 * 영숫자 2자 이상 연속. 1자(`a`, `7`)를 식별자로 치면 조사 뒤에 붙은 숫자 하나 때문에
 * 순수 한국어 질의가 identifier로 잘못 분류된다.
 */
const ALNUM_RUN = /[A-Za-z0-9]{2,}/;

export function classifyQueryKind(query: string): QueryKind {
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  const hasIdentifierToken = tokens.some(
    (token) => ASCII_TOKEN.test(token) && ALNUM_RUN.test(token),
  );
  if (hasIdentifierToken) return "identifier";
  if (HANGUL.test(query)) return "korean-prose";
  return "other";
}
