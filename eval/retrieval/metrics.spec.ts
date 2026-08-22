import { describe, expect, it } from "vitest";

import {
  aggregate,
  cutoffWindow,
  hasAmbiguousTie,
  RECALL_K,
  scoreCase,
  toRecordRanking,
  type RankedHit,
} from "./metrics.js";

/**
 * ⚠️ 픽스처의 점수는 **전부 서로 다르다**(T-011 F-9). atlas-local은 같은 점수 후보의 순서를
 * 보장하지 않으므로, 동점에 의존하는 단언은 간헐 실패하고 뮤테이션을 가짜로 죽인다.
 * 동점은 그것을 다루는 describe에서만 명시적으로 심는다.
 */
function hit(recordId: string, score: number): RankedHit {
  return { recordId, score };
}

const A = "aaaaaaaaaaaaaaaaaaaaaaa1";
const B = "bbbbbbbbbbbbbbbbbbbbbbb2";
const C = "ccccccccccccccccccccccc3";
const D = "ddddddddddddddddddddddd4";
const E = "eeeeeeeeeeeeeeeeeeeeeee5";
const F = "fffffffffffffffffffffff6";

describe("toRecordRanking", () => {
  it("같은 record의 두 번째 청크를 접는다 — 랭킹의 단위는 record다", () => {
    const ranking = toRecordRanking([
      hit(A, 0.9),
      hit(A, 0.8), // specs/03 §2: record당 최대 2청크
      hit(B, 0.7),
    ]);
    expect(ranking).toEqual([
      { recordId: A, score: 0.9 },
      { recordId: B, score: 0.7 },
    ]);
  });

  it("첫 등장이 그 record의 점수다 — 나중 청크가 점수를 덮지 않는다", () => {
    expect(toRecordRanking([hit(A, 0.9), hit(A, 0.1)])[0]?.score).toBe(0.9);
  });
});

describe("scoreCase — Recall@5는 적중률이다", () => {
  it("정답 중 하나라도 top-5 record에 있으면 hit다 (모호 클러스터 전원 열거 대응)", () => {
    const outcome = scoreCase(
      [hit(A, 0.9), hit(B, 0.8), hit(C, 0.7), hit(D, 0.6), hit(E, 0.5)],
      // BGP 클러스터처럼 넷을 다 열거해도 그중 하나면 정답이다.
      [C, D, E, F],
    );
    expect(outcome.hit).toBe(true);
    expect(outcome.firstHitRank).toBe(3);
    expect(outcome.reciprocalRank).toBeCloseTo(1 / 3, 10);
  });

  it("6위의 정답은 miss다 — 컷오프 밖은 재지 않는다", () => {
    const outcome = scoreCase(
      [hit(A, 0.9), hit(B, 0.8), hit(C, 0.7), hit(D, 0.6), hit(E, 0.5), hit(F, 0.4)],
      [F],
    );
    expect(outcome.hit).toBe(false);
    expect(outcome.firstHitRank).toBeNull();
    // MRR도 같은 top-k 위에서 잰다 — recall에서 0인데 MRR에서만 1/6을 받지 않는다.
    expect(outcome.reciprocalRank).toBe(0);
  });

  it("record 접기 뒤에 컷오프를 적용한다 — 청크 6개가 record 3개면 3위까지만 남는다", () => {
    const outcome = scoreCase(
      [hit(A, 0.9), hit(A, 0.85), hit(B, 0.8), hit(B, 0.75), hit(C, 0.7), hit(C, 0.65)],
      [C],
    );
    expect(outcome.rankedRecordIds).toEqual([A, B, C]);
    expect(outcome.firstHitRank).toBe(3);
  });

  it("firstHitRank는 miss일 때 null이다 — 0이 아니다", () => {
    // 0은 "1위보다 좋은 순위"로 오독될 수 있고 평균에 섞이면 MRR을 오염시킨다.
    expect(scoreCase([hit(A, 0.9)], [B]).firstHitRank).toBeNull();
  });

  it("hit이 하나도 없는 빈 응답도 죽지 않는다", () => {
    const outcome = scoreCase([], [A]);
    expect(outcome).toMatchObject({ hit: false, firstHitRank: null, reciprocalRank: 0 });
  });

  it("RECALL_K는 specs/05가 고정한 5다", () => {
    expect(RECALL_K).toBe(5);
  });
});

describe("동점 모호성 — 재실행하면 결과가 달라질 수 있는가 (T-011 F-9)", () => {
  it("정답과 오답이 같은 점수로 컷오프를 가로지르면 모호하다", () => {
    const outcome = scoreCase(
      [hit(A, 0.9), hit(B, 0.8), hit(C, 0.7), hit(D, 0.6), hit(E, 0.5), hit(F, 0.5)],
      [F], // 5위 E와 6위 F가 동점 — 순서가 뒤집히면 hit이 된다
    );
    expect(outcome.hit).toBe(false);
    expect(outcome.ambiguousTie).toBe(true);
  });

  it("top-k 안의 동점도 MRR을 흔들면 모호하다", () => {
    const outcome = scoreCase([hit(A, 0.9), hit(B, 0.9), hit(C, 0.3)], [B]);
    expect(outcome.firstHitRank).toBe(2);
    expect(outcome.ambiguousTie).toBe(true);
  });

  it("정답 여부가 같은 동점은 모호하지 않다 — 순서가 바뀌어도 지표가 변하지 않는다", () => {
    const outcome = scoreCase([hit(A, 0.9), hit(B, 0.9), hit(C, 0.3)], [C]);
    expect(outcome.ambiguousTie).toBe(false);
  });

  it("점수가 전부 다르면 모호하지 않다", () => {
    const outcome = scoreCase([hit(A, 0.9), hit(B, 0.8), hit(C, 0.7)], [B]);
    expect(outcome.ambiguousTie).toBe(false);
  });

  it("cutoffWindow는 k번째와 동점인 뒤쪽 전부를 끌어온다 — slice(0,k+1)로는 부족하다", () => {
    const ranking = [
      { recordId: A, score: 0.9 },
      { recordId: B, score: 0.8 },
      { recordId: C, score: 0.7 },
      { recordId: D, score: 0.6 },
      { recordId: E, score: 0.5 },
      { recordId: F, score: 0.5 },
      { recordId: "999999999999999999999999", score: 0.5 },
    ];
    expect(cutoffWindow(ranking, 5)).toHaveLength(7);
    expect(hasAmbiguousTie(cutoffWindow(ranking, 5), new Set(["999999999999999999999999"]))).toBe(
      true,
    );
  });
});

describe("aggregate", () => {
  it("recall은 적중 케이스 비율, mrr은 역순위 평균이다", () => {
    const outcomes = [
      scoreCase([hit(A, 0.9), hit(B, 0.8)], [A]), // rank 1 → 1.0
      scoreCase([hit(A, 0.9), hit(B, 0.8)], [B]), // rank 2 → 0.5
      scoreCase([hit(A, 0.9), hit(B, 0.8)], [C]), // miss   → 0
    ];
    const summary = aggregate(outcomes);
    expect(summary.caseCount).toBe(3);
    expect(summary.recall).toBeCloseTo(2 / 3, 4);
    expect(summary.mrr).toBeCloseTo(1.5 / 3, 4);
  });

  /**
   * 부동소수 꼬리(0.6666666666666666)가 리포트에 그대로 박히면 커밋된 리포트끼리의 diff가
   * 매번 더러워져 시계열이 안 읽힌다. 자리수를 여기서 못박는다.
   */
  it("소수 4자리로 자른다 — 리포트에 부동소수 꼬리가 박히지 않는다", () => {
    const outcomes = [
      scoreCase([hit(A, 0.9)], [A]),
      scoreCase([hit(A, 0.9)], [A]),
      scoreCase([hit(A, 0.9)], [B]),
    ];
    const summary = aggregate(outcomes);
    expect(summary.recall).toBe(0.6667);
    expect(summary.mrr).toBe(0.6667);
  });

  it("케이스 0건이면 caseCount 0을 그대로 남긴다 — 0.0을 지표로 만들어 내지 않는다", () => {
    expect(aggregate([])).toEqual({ caseCount: 0, recall: 0, mrr: 0, ambiguousTieCount: 0 });
  });

  it("모호 동점 케이스를 센다", () => {
    const outcomes = [
      scoreCase([hit(A, 0.9), hit(B, 0.9)], [B]),
      scoreCase([hit(A, 0.9), hit(B, 0.8)], [A]),
    ];
    expect(aggregate(outcomes).ambiguousTieCount).toBe(1);
  });
});
