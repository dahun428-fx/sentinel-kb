/**
 * **이 파일이 T-034의 핵심 방어다.**
 *
 * T-031의 린터가 재작성 루프의 지시문을 만든다 — 즉 파이프라인의 아티클은 린터 규칙에 맞춰
 * 고쳐진 글이다. 그 글을 같은 규칙으로 채점하면 "린터를 통과한 글이 린터 기준으로 좋다"는
 * 동어반복이 되고, §6이 재려던 것은 하나도 재지지 않는다.
 *
 * 그래서 judge에게 **실제로 도달하는 문자열**(system + user)이 린터의 어휘와 겹치지 않음을
 * 기계로 잠근다. 상수 사본을 여기 적지 않고 `@sentinel/core`에서 **살아 있는 값**을 읽는 것이
 * 요점이다 — T-016이 도구 카탈로그를 스냅샷하지 않고 `createMcpServer` 실물에서 읽은 것과
 * 같은 이유다. 사본을 적으면 나중에 린터에 표현이 추가돼도 이 테스트는 조용히 통과한다.
 */
import { BANNED_PHRASES, HYPE_MODIFIERS, LINT_RULES, META_OPENERS } from "@sentinel/core";
import { describe, expect, it } from "vitest";

import { blindCorpus, toJudgeInput } from "./blind.js";
import { renderStyleJudgeMessage, STYLE_JUDGE_SYSTEM } from "./judge.js";

/** 판정 대상 본문 자리에 들어가는 중립 텍스트. 린터 어휘를 일부러 담지 않는다. */
const NEUTRAL_TEXT = "어제 배포한 뒤 로그를 다시 읽었다. 원인은 캐시 키였다.";

const RENDERED = `${STYLE_JUDGE_SYSTEM}\n${renderStyleJudgeMessage({ itemId: "ITEM-01", text: NEUTRAL_TEXT })}`;

describe("judge는 린터 규칙을 모른 채로 판정한다", () => {
  it("금지 표현 목록이 judge 프롬프트에 하나도 실리지 않는다", () => {
    const leaked = BANNED_PHRASES.filter((phrase) => RENDERED.includes(phrase));

    expect(leaked).toEqual([]);
  });

  it("과장 수식 목록이 judge 프롬프트에 하나도 실리지 않는다", () => {
    const leaked = HYPE_MODIFIERS.filter((word) => RENDERED.includes(word));

    expect(leaked).toEqual([]);
  });

  it("메타 서두 목록이 judge 프롬프트에 하나도 실리지 않는다", () => {
    const leaked = META_OPENERS.filter((phrase) => RENDERED.includes(phrase));

    expect(leaked).toEqual([]);
  });

  it("린트 규칙 id가 judge 프롬프트에 하나도 실리지 않는다", () => {
    const leaked = LINT_RULES.filter((rule) => RENDERED.includes(rule));

    expect(leaked).toEqual([]);
  });

  it("살아 있는 린터 상수를 읽는다 — 사본을 비교하지 않는다", () => {
    // 이 단언이 깨지면 위 네 개가 빈 배열을 빈 배열과 비교하고 있다는 뜻이다.
    expect(BANNED_PHRASES.length).toBeGreaterThan(0);
    expect(HYPE_MODIFIERS.length).toBeGreaterThan(0);
    expect(META_OPENERS.length).toBeGreaterThan(0);
    expect(LINT_RULES.length).toBeGreaterThan(0);
  });

  it("판별 기준 목록을 아예 나열하지 않는다 (새 린터가 되지 않기 위해)", () => {
    const bulletLines = STYLE_JUDGE_SYSTEM.split("\n").filter((line) => /^\s*[-*•]\s/u.test(line));

    expect(bulletLines).toEqual([]);
  });

  it("밀도 하한·재작성 같은 파이프라인 내부 어휘도 싣지 않는다", () => {
    for (const word of ["린트", "린터", "밀도", "재작성", "규칙", "위반"]) {
      expect(STYLE_JUDGE_SYSTEM).not.toContain(word);
    }
  });
});

describe("judge는 글의 출처를 알 수 없다", () => {
  it("judge 입력에는 itemId와 text뿐이다 — origin을 담을 자리가 없다", () => {
    const [item] = blindCorpus([
      { origin: "generated", sourceRef: "ART-pattern-01", text: NEUTRAL_TEXT },
    ]);
    if (item === undefined) throw new Error("코퍼스가 비었다");

    expect(Object.keys(toJudgeInput(item)).sort()).toEqual(["itemId", "text"]);
  });

  it("렌더된 요청에 출처·정답 문자열이 실리지 않는다", () => {
    const [item] = blindCorpus([
      { origin: "control", sourceRef: "eval/style/corpus.ts:CTL-01", text: NEUTRAL_TEXT },
    ]);
    if (item === undefined) throw new Error("코퍼스가 비었다");
    const rendered = renderStyleJudgeMessage(toJudgeInput(item));

    expect(rendered).not.toContain("control");
    expect(rendered).not.toContain("CTL-01");
    expect(rendered).not.toContain("corpus.ts");
    expect(rendered).toContain(item.itemId);
  });
});
