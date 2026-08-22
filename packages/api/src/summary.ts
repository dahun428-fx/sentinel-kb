/**
 * `summary` 생성. 출처: specs/04-api.md 규약
 * > `summary`는 서버가 생성(첫 2문장 또는 LLM 요약 캐시) — 클라이언트가 본문을 받지 않고도
 * > 판단 가능해야 함(NFR-03의 기반).
 *
 * **LLM은 쓰지 않는다.** 저장 경로는 동기 게이트이고(specs/00 FR-06의 sanitizer와 같은 축),
 * 거기에 네트워크 호출을 넣으면 POST 지연이 모델 응답 시간에 묶인다. "첫 2문장"을 택한다.
 * LLM 요약 캐시는 스펙이 열어 둔 다른 갈래이며 T-007 스코프 밖이다.
 *
 * ## 어느 섹션에서 뽑는가
 * - `incident` → **`symptom`**. 검색 결과를 훑는 사람이 맞추려는 것은 "내가 지금 겪는 증상과
 *   같은 건가"다. `resolution`을 요약하면 "이게 내 문제인가"를 판단할 수 없고, `rootCause`는
 *   선택 필드라 없을 수 있다(contracts). `symptom`은 필수이므로 항상 존재한다.
 * - `divergence` → **`expected`**. 이 종류의 판단 기준은 "무엇을 의도했는데 어긋났나"다.
 *   `actual`(에이전트가 만든 것)만 보면 맥락 없는 결과물 서술이고, `correction`은 해결책이라
 *   incident의 `resolution`과 같은 이유로 식별에 쓸 수 없다. `expected`도 필수 필드다.
 */

/** specs/04의 "첫 2문장". 숫자를 라우터에 흩뿌리지 않기 위한 상수다. */
export const SUMMARY_SENTENCE_COUNT = 2;

/**
 * 요약 길이 상한. 구두점이 하나도 없는 본문(불릿 목록, 로그 덤프)은 "첫 2문장"이 곧
 * 본문 전체가 되어 목록 응답이 본문을 실어 나른다 — NFR-03이 막으려는 바로 그 상태다.
 * 상한을 넘으면 자르고 말줄임표를 붙인다. specs/07 §1의 "summary(3줄 이내)"와 같은 취지다.
 */
export const SUMMARY_MAX_CHARS = 400;

/** 문장 종결 부호. 한국어 기록은 `.`을 쓰지만 전각·감탄·의문도 종결로 본다. */
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);

/**
 * 앞에서부터 `count`개 문장을 뽑는다.
 *
 * 줄바꿈도 문장 경계로 친다 — 종결 부호 없이 줄로 나열한 본문에서 이게 없으면
 * 첫 "문장"이 본문 전체가 된다.
 */
export function firstSentences(text: string, count: number): string {
  const sentences: string[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    current = "";
    if (trimmed !== "") sentences.push(trimmed);
  };

  for (const char of text) {
    if (char === "\n") {
      flush();
    } else {
      current += char;
      if (SENTENCE_TERMINATORS.has(char)) flush();
    }
    if (sentences.length >= count) break;
  }
  if (sentences.length < count) flush();

  return sentences.slice(0, count).join(" ");
}

/**
 * `summary`를 만든다. 입력은 **새니타이즈를 통과한 본문**이어야 한다 —
 * 원문에서 뽑으면 마스킹된 시크릿이 요약에 그대로 남아 목록·검색 응답으로 퍼진다.
 *
 * 근거 섹션이 비어 있는 경우는 계약상 없지만(둘 다 필수 필드), 그래도 빈 문자열을 돌려주지
 * 않는다 — `RecordSchema.summary`가 `min(1)`이라 빈 값은 저장 자체가 실패한다.
 * 제목으로 폴백하는 편이 "요약 없음"보다 언제나 낫다.
 */
export function buildSummary(sourceText: string, title: string): string {
  const picked = firstSentences(sourceText, SUMMARY_SENTENCE_COUNT);
  const summary = picked === "" ? title.trim() : picked;
  return summary.length > SUMMARY_MAX_CHARS
    ? `${summary.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`
    : summary;
}
