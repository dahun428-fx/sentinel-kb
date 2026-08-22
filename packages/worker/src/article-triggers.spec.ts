/**
 * 트리거 조건 유닛 테스트 (T-029 Acceptance 3 — 유형별 8케이스).
 *
 * 문턱이 이 파이프라인의 유일한 판단 지점이므로, 여기서 잠그는 것은 "돈다"가 아니라
 * **"조건이 실제로 걸러 낸다"**이다. 각 유형마다 문턱 아래/위 한 쌍씩 두는 이유가 그것이다 —
 * 아래쪽 케이스가 없으면 "전부 후보로 만드는" 구현도 통과한다.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ARTICLE_TRIGGER_THRESHOLDS,
  evaluateArticleTriggers,
  isArticleMaterial,
  lastCompleteWeek,
  type TriggerRecord,
} from "./article-triggers.js";

const NOW = new Date("2026-08-20T03:00:00Z"); // 목요일
/** 직전 완결 주 = 2026-08-10(월) ~ 2026-08-17(월) 직전. */
const LAST_WEEK = new Date("2026-08-12T00:00:00Z");
/** 아주 오래된 날짜 — 다이제스트 창 밖. */
const OLD = new Date("2026-01-05T00:00:00Z");

let seq = 0;
function oid(): string {
  seq += 1;
  return seq.toString(16).padStart(24, "0");
}

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    _id: oid(),
    type: "incident",
    title: "무언가 터졌다",
    tags: [],
    sanitizeFlags: [],
    status: "published",
    createdAt: OLD,
    helpfulFeedbackCount: 0,
    ...overrides,
  };
}

function evaluate(records: readonly TriggerRecord[]): ReturnType<typeof evaluateArticleTriggers> {
  return evaluateArticleTriggers(records, { now: NOW });
}

function kinds(records: readonly TriggerRecord[]): string[] {
  return evaluate(records).map((candidate) => candidate.kind);
}

/** 태그 문서빈도 상한에 걸리지 않도록 클러스터 밖 배경 레코드를 채운다. */
function padding(count: number): TriggerRecord[] {
  return Array.from({ length: count }, () => record({ tags: ["noise" + oid()] }));
}

describe("A. 케이스 스터디 — helped 피드백 문턱", () => {
  it("1) helped 1건이면 후보가 아니다", () => {
    expect(kinds([record({ helpfulFeedbackCount: 1 })])).not.toContain("case");
  });

  it("2) helped 2건이면 후보가 된다", () => {
    const candidates = evaluate([record({ helpfulFeedbackCount: 2, title: "504 타임아웃" })]);
    expect(candidates.map((c) => c.kind)).toEqual(["case"]);
    expect(candidates[0]?.title).toContain("504 타임아웃");
    expect(candidates[0]?.sourceRecordIds).toHaveLength(1);
  });
});

describe("B. 패턴 — 동일 태그 클러스터 크기", () => {
  it("3) 같은 태그 2건이면 후보가 아니다", () => {
    const records = [record({ tags: ["mongodb"] }), record({ tags: ["mongodb"] })];
    expect(kinds([...records, ...padding(8)])).not.toContain("pattern");
  });

  it("4) 같은 태그 3건이면 후보가 되고 소스가 그 3건이다", () => {
    const cluster = [
      record({ tags: ["mongodb"] }),
      record({ tags: ["mongodb"] }),
      record({ tags: ["mongodb"] }),
    ];
    const candidates = evaluate([...cluster, ...padding(8)]).filter((c) => c.kind === "pattern");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceRecordIds).toEqual(cluster.map((r) => r._id).sort());
  });

  it("5) 코퍼스 전체에 붙은 태그는 문턱을 넘어도 후보가 아니다", () => {
    // 6건 전부에 `public-postmortem`이 붙어 있다 = 문서빈도 100%.
    // 클러스터 크기는 3을 넘지만 변별력이 0이라 아티클 주제가 되지 못한다.
    const records = Array.from({ length: 6 }, () => record({ tags: ["public-postmortem"] }));
    expect(kinds(records)).not.toContain("pattern");
  });

  it("한 레코드가 같은 태그를 두 번 달아도 클러스터가 부풀지 않는다", () => {
    const records = [
      record({ tags: ["zod", "zod"] }),
      record({ tags: ["zod", "zod"] }),
      ...padding(8),
    ];
    expect(kinds(records)).not.toContain("pattern");
  });
});

describe("C. 이격 리포트 — 모델·도구별 divergence 건수", () => {
  const divergence = (model: string): TriggerRecord =>
    record({ type: "divergence", context: { model }, tags: [oid()] });

  it("6) 같은 모델 2건이면 후보가 아니다", () => {
    expect(kinds([divergence("claude"), divergence("claude")])).not.toContain("divergence-report");
  });

  it("7) 같은 모델 3건이면 후보가 된다", () => {
    const candidates = evaluate([
      divergence("claude"),
      divergence("claude"),
      divergence("claude"),
    ]);
    expect(candidates.map((c) => c.kind)).toEqual(["divergence-report"]);
  });

  it("모델과 도구 축을 따로 센다", () => {
    const records = [
      record({ type: "divergence", context: { model: "claude", tool: "implementer" }, tags: [oid()] }),
      record({ type: "divergence", context: { model: "claude", tool: "implementer" }, tags: [oid()] }),
      record({ type: "divergence", context: { model: "claude", tool: "implementer" }, tags: [oid()] }),
    ];
    // 같은 3건이 model 축에서 한 번, tool 축에서 한 번 = 후보 2건.
    expect(kinds(records)).toEqual(["divergence-report", "divergence-report"]);
  });

  it("incident는 이격 리포트 재료가 아니다", () => {
    const records = Array.from({ length: 5 }, () =>
      record({ type: "incident", context: { model: "claude" }, tags: [oid()] }),
    );
    expect(kinds(records)).not.toContain("divergence-report");
  });

  it("model·tool이 비어 있는 divergence는 어느 클러스터에도 들어가지 않는다", () => {
    const records = Array.from({ length: 5 }, () =>
      record({ type: "divergence", context: { model: "  " }, tags: [oid()] }),
    );
    expect(kinds(records)).not.toContain("divergence-report");
  });
});

describe("D. 주간 다이제스트 — 직전 완결 주 신규 건수", () => {
  it("8) 직전 주 4건이면 후보가 아니고 5건이면 후보가 된다", () => {
    const four = Array.from({ length: 4 }, () => record({ createdAt: LAST_WEEK, tags: [oid()] }));
    expect(kinds(four)).not.toContain("digest");

    const five = [...four, record({ createdAt: LAST_WEEK, tags: [oid()] })];
    expect(kinds(five)).toContain("digest");
  });

  it("이번 주 레코드는 세지 않는다 — 진행 중인 주는 소스 집합이 계속 자란다", () => {
    const thisWeek = Array.from({ length: 6 }, () =>
      record({ createdAt: new Date("2026-08-19T00:00:00Z"), tags: [oid()] }),
    );
    expect(kinds(thisWeek)).not.toContain("digest");
  });

  it("주 경계는 UTC 월요일 00:00이고 반열린 구간이다", () => {
    const { start, end } = lastCompleteWeek(NOW);
    expect(start.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("월요일에 돌려도 직전 완결 주를 본다", () => {
    const { start, end } = lastCompleteWeek(new Date("2026-08-17T02:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });
});

describe("재료 자격 — 발행물에 들어가면 안 되는 레코드", () => {
  it("injection-suspect 레코드는 재료가 아니다 (NFR-05, specs/08 §7)", () => {
    expect(isArticleMaterial(record({ sanitizeFlags: ["injection-suspect"] }))).toBe(false);
  });

  it("injection-suspect가 섞이면 클러스터 크기에 세지 않는다", () => {
    const records = [
      record({ tags: ["ci"] }),
      record({ tags: ["ci"] }),
      record({ tags: ["ci"], sanitizeFlags: ["injection-suspect"] }),
      ...padding(8),
    ];
    // 3건처럼 보이지만 재료는 2건이다.
    expect(kinds(records)).not.toContain("pattern");
  });

  it("injection-suspect 레코드는 어떤 후보의 소스에도 들어가지 않는다", () => {
    const poisoned = record({
      tags: ["ci"],
      sanitizeFlags: ["injection-suspect"],
      helpfulFeedbackCount: 9,
      createdAt: LAST_WEEK,
    });
    const clean = Array.from({ length: 6 }, () =>
      record({ tags: ["ci"], createdAt: LAST_WEEK }),
    );
    const sources = evaluate([poisoned, ...clean]).flatMap((c) => c.sourceRecordIds);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).not.toContain(poisoned._id);
  });

  it("secret-masked는 재료로 통과시킨다 — 이미 마스킹됐고 인용 규칙은 T-030의 몫이다", () => {
    expect(isArticleMaterial(record({ sanitizeFlags: ["secret-masked"] }))).toBe(true);
  });

  it("draft 레코드는 재료가 아니다 — 미완성 기록이 편찬되면 안 된다", () => {
    expect(isArticleMaterial(record({ status: "draft" }))).toBe(false);
    const drafts = Array.from({ length: 6 }, () =>
      record({ status: "draft", tags: ["ci"], createdAt: LAST_WEEK }),
    );
    expect(evaluate(drafts)).toEqual([]);
  });
});

describe("결정론", () => {
  it("입력 순서가 달라도 같은 후보를 같은 순서로 낸다", () => {
    const records = [
      record({ tags: ["zod"] }),
      record({ tags: ["zod"] }),
      record({ tags: ["zod"] }),
      ...padding(8),
    ];
    const forward = evaluate(records);
    const backward = evaluate([...records].reverse());
    expect(backward).toEqual(forward);
  });

  it("아무것도 문턱을 넘지 않으면 후보가 0건이다", () => {
    expect(evaluate([record(), record()])).toEqual([]);
  });

  it("문턱 기본값이 specs/08 §1 표와 일치한다", () => {
    expect(DEFAULT_ARTICLE_TRIGGER_THRESHOLDS.caseHelpfulFeedback).toBe(2);
    expect(DEFAULT_ARTICLE_TRIGGER_THRESHOLDS.patternClusterSize).toBe(3);
    expect(DEFAULT_ARTICLE_TRIGGER_THRESHOLDS.divergenceClusterSize).toBe(3);
    expect(DEFAULT_ARTICLE_TRIGGER_THRESHOLDS.digestNewRecords).toBe(5);
  });
});
