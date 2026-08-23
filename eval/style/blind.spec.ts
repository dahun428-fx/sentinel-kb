/**
 * 블라인딩이 실제로 가리는지 본다. **가리지 못하면 §6의 판정은 아무것도 재지 않는다** —
 * judge가 순서나 번호로 정답을 읽을 수 있으면 판별 정확도는 문체의 함수가 아니게 된다.
 */
import { describe, expect, it } from "vitest";

import { blindCorpus, BLIND_SEED, hashSeed, shuffle, toJudgeInput } from "./blind.js";
import type { StylePiece } from "./corpus.js";

/** 실제 러너가 만드는 모양 그대로 — **종류별로 뭉쳐 있다.** 그래서 셔플이 필요하다. */
function groupedCorpus(): StylePiece[] {
  const make = (origin: StylePiece["origin"], index: number): StylePiece => ({
    origin,
    sourceRef: `${origin}-${String(index)}`,
    text: `${origin} 본문 ${String(index)}`,
  });
  return [
    make("generated", 1),
    make("generated", 2),
    make("human", 1),
    make("human", 2),
    make("human", 3),
    make("control", 1),
    make("control", 2),
    make("control", 3),
    make("control", 4),
  ];
}

describe("blindCorpus", () => {
  it("입력 순서를 그대로 내보내지 않는다 — 순서가 곧 정답표가 되기 때문이다", () => {
    const input = groupedCorpus();

    const blinded = blindCorpus(input);

    expect(blinded.map((item) => item.origin)).not.toEqual(input.map((piece) => piece.origin));
  });

  it("글을 잃거나 더하지 않는다 (셔플은 순열이다)", () => {
    const input = groupedCorpus();

    const blinded = blindCorpus(input);

    expect(blinded).toHaveLength(input.length);
    expect([...blinded.map((item) => item.sourceRef)].sort()).toEqual(
      [...input.map((piece) => piece.sourceRef)].sort(),
    );
  });

  it("번호는 셔플 뒤에 붙는다 — ITEM-01이 언제나 첫 생성분이면 번호가 곧 출처다", () => {
    const input = groupedCorpus();

    const blinded = blindCorpus(input);
    const first = blinded[0];

    expect(blinded.map((item) => item.itemId)).toEqual([
      "ITEM-01",
      "ITEM-02",
      "ITEM-03",
      "ITEM-04",
      "ITEM-05",
      "ITEM-06",
      "ITEM-07",
      "ITEM-08",
      "ITEM-09",
    ]);
    expect(first?.sourceRef).not.toBe(input[0]?.sourceRef);
  });

  it("같은 시드면 같은 배치다 — 리포트가 재현된다", () => {
    const input = groupedCorpus();

    const a = blindCorpus(input, "seed-x");
    const b = blindCorpus(input, "seed-x");

    expect(a).toEqual(b);
  });

  it("시드가 다르면 배치가 달라진다", () => {
    const input = groupedCorpus();

    const a = blindCorpus(input, "seed-x").map((item) => item.sourceRef);
    const b = blindCorpus(input, "seed-y").map((item) => item.sourceRef);

    expect(a).not.toEqual(b);
  });

  it("기본 시드가 고정돼 있다", () => {
    expect(BLIND_SEED).toBe("T-034-style-eval");
  });
});

describe("toJudgeInput", () => {
  it("origin과 sourceRef를 떨어뜨린다", () => {
    const item = {
      itemId: "ITEM-03",
      text: "본문",
      origin: "human" as const,
      sourceRef: "docs/analysis/T-004-POSTMORTEM.md",
    };

    const input = toJudgeInput(item);

    expect(input).toEqual({ itemId: "ITEM-03", text: "본문" });
    expect(JSON.stringify(input)).not.toContain("human");
    expect(JSON.stringify(input)).not.toContain("POSTMORTEM");
  });
});

describe("shuffle", () => {
  it("빈 배열과 1개 배열을 그대로 돌려준다", () => {
    expect(shuffle([], "s")).toEqual([]);
    expect(shuffle(["a"], "s")).toEqual(["a"]);
  });

  it("hashSeed는 결정론적이고 시드마다 다르다", () => {
    expect(hashSeed("a")).toBe(hashSeed("a"));
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });
});
