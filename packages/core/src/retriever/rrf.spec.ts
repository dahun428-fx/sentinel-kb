/**
 * T-011 Acceptance 1·2. 순수 함수라 컨테이너 없이 판정된다.
 *  - 1: "RRF 유닛 테스트: 알려진 랭킹 2개 → 기대 융합 순서"
 *  - 2: "dedupe 테스트: 한 record의 4개 섹션이 상위일 때 2개만 남음"
 */
import { describe, expect, it } from "vitest";

import { capByRecordId, dedupeByRecordId, fuseRrf } from "./rrf.js";

interface Fixture {
  readonly chunkId: string;
  readonly recordId: string;
}

const chunk = (chunkId: string, recordId = `rec-${chunkId}`): Fixture => ({ chunkId, recordId });

const ids = (entries: readonly { candidate: Fixture }[]): string[] =>
  entries.map((e) => e.candidate.chunkId);

describe("fuseRrf (Acceptance 1)", () => {
  /*
   * 알려진 랭킹 2개.
   *   vector: X(1) A(2) Y(3) B(4)
   *   text:   C(1) D(2) E(3) Y(4)
   * Y만 두 경로에 모두 있고, 나머지는 한쪽에만 있다.
   */
  const vector = [chunk("X"), chunk("A"), chunk("Y"), chunk("B")];
  const text = [chunk("C"), chunk("D"), chunk("E"), chunk("Y")];

  it("k=1이면 1위 단독 진입이 양쪽 하위 진입을 이긴다", () => {
    // X = 1/2 = .5, C = 1/2 = .5, Y = 1/4 + 1/5 = .45, A = D = 1/3, E = .25, B = .2
    expect(ids(fuseRrf(vector, text, 1))).toEqual(["C", "X", "Y", "A", "D", "E", "B"]);
  });

  it("k=60이면 같은 입력의 1위가 뒤집힌다 — k가 순위를 실제로 바꾼다", () => {
    // Y = 1/63 + 1/64 = .031498 > X = C = 1/61 = .016393
    // k를 무시하고 고정 상수를 쓰면 두 테스트 중 하나는 반드시 죽는다.
    expect(ids(fuseRrf(vector, text, 60))).toEqual(["Y", "C", "X", "A", "D", "E", "B"]);
  });

  it("점수가 Σ 1/(k + rank) 그대로다", () => {
    const fused = fuseRrf(vector, text, 60);
    const byId = new Map(fused.map((e) => [e.candidate.chunkId, e]));

    expect(byId.get("Y")?.score).toBeCloseTo(1 / 63 + 1 / 64, 12);
    expect(byId.get("X")?.score).toBeCloseTo(1 / 61, 12);
    expect(byId.get("B")?.score).toBeCloseTo(1 / 64, 12);
  });

  it("어느 경로가 몇 위로 기여했는지 남긴다", () => {
    const byId = new Map(fuseRrf(vector, text, 60).map((e) => [e.candidate.chunkId, e]));

    expect(byId.get("Y")).toMatchObject({ vectorRank: 3, textRank: 4 });
    expect(byId.get("X")).toMatchObject({ vectorRank: 1, textRank: null });
    expect(byId.get("C")).toMatchObject({ vectorRank: null, textRank: 1 });
  });

  /** T-010 F-6: `lucene.standard`가 한국어를 못 잡아 텍스트 경로가 0건이 되는 것은 정상 경로다. */
  it("한쪽 경로가 0건이어도 다른 경로만으로 결과를 낸다", () => {
    expect(ids(fuseRrf(vector, [], 60))).toEqual(["X", "A", "Y", "B"]);
    expect(ids(fuseRrf([], text, 60))).toEqual(["C", "D", "E", "Y"]);
    expect(fuseRrf([], [], 60)).toEqual([]);
  });

  it("같은 점수여도 순서가 결정론적이다", () => {
    // A와 D는 각각 vector 2위 / text 2위 — 점수가 정확히 같은 float다.
    const first = ids(fuseRrf(vector, text, 60));
    const second = ids(fuseRrf([...vector], [...text], 60));
    expect(second).toEqual(first);
    expect(first.indexOf("A")).toBeLessThan(first.indexOf("D"));
  });
});

describe("dedupeByRecordId (Acceptance 2)", () => {
  it("한 record의 4개 섹션이 상위를 점유해도 2개만 남는다", () => {
    const long = "rec-long";
    const items = [
      { chunkId: "s1", recordId: long },
      { chunkId: "s2", recordId: long },
      { chunkId: "s3", recordId: long },
      { chunkId: "s4", recordId: long },
      { chunkId: "o1", recordId: "rec-other" },
    ];

    expect(dedupeByRecordId(items, 2).map((i) => i.chunkId)).toEqual(["s1", "s2", "o1"]);
  });

  it("상한을 넘기지 않는 record는 그대로 통과한다", () => {
    const items = [
      { chunkId: "a", recordId: "r1" },
      { chunkId: "b", recordId: "r2" },
      { chunkId: "c", recordId: "r1" },
    ];
    expect(dedupeByRecordId(items, 2).map((i) => i.chunkId)).toEqual(["a", "b", "c"]);
  });

  it("상한 1이면 record당 1개만 남는다 — 상한이 실제로 읽힌다", () => {
    const items = [
      { chunkId: "a", recordId: "r1" },
      { chunkId: "b", recordId: "r1" },
      { chunkId: "c", recordId: "r2" },
    ];
    expect(dedupeByRecordId(items, 1).map((i) => i.chunkId)).toEqual(["a", "c"]);
  });
});

describe("capByRecordId (T-005 F-3)", () => {
  /** 28청크짜리 레코드 하나 + 짧은 레코드 여러 건. 슬롯 독점이 실제로 풀리는지. */
  const monster = Array.from({ length: 28 }, (_, i) => ({
    chunkId: `long-${String(i)}`,
    recordId: "rec-long",
  }));
  const shorts = Array.from({ length: 10 }, (_, i) => ({
    chunkId: `short-${String(i)}`,
    recordId: `rec-short-${String(i)}`,
  }));

  it("장문 레코드가 후보 슬롯을 독점하지 못한다", () => {
    // overfetch로 긁어온 raw 후보(장문 28개가 앞줄을 전부 차지) → 상한 2 → K=20으로 절단
    const capped = capByRecordId([...monster, ...shorts], 2, 20);

    expect(capped.filter((c) => c.recordId === "rec-long")).toHaveLength(2);
    expect(new Set(capped.map((c) => c.recordId)).size).toBe(11);
  });

  it("상한이 없으면(=상한을 28로 두면) 장문이 그대로 20슬롯을 먹는다 — 대조군", () => {
    const uncapped = capByRecordId([...monster, ...shorts], 28, 20);
    expect(uncapped.filter((c) => c.recordId === "rec-long")).toHaveLength(20);
    expect(new Set(uncapped.map((c) => c.recordId)).size).toBe(1);
  });

  it("limit이 실제로 잘린다", () => {
    expect(capByRecordId(shorts, 2, 3)).toHaveLength(3);
  });
});
