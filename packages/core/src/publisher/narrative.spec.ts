/**
 * 서사 재료 테스트 — **T-030 F-1이 경고한 그 경로를 재는 테스트다.**
 *
 * T-031은 레코드 산문을 초안 프롬프트에 넣기로 결정했다(`narrative.ts` 판단 1).
 * 그 결정이 T-030의 방어를 무너뜨리지 않았다는 것은 주장이 아니라 **관측**으로만 말할 수
 * 있고, 관측 대상은 T-030이 이미 심어 둔 적대 입력 넷이다:
 * 마스킹된 레코드 · injection-suspect 레코드 · 플래그 없는 잔여 유출 · 플래그 없는 일본어 인젝션.
 */
import { describe, expect, it } from "vitest";

import { extractFacts } from "../facts/extract.js";
import {
  FACT_FIXTURE_RECORDS,
  FIXTURE_IDS,
  JAPANESE_INJECTION_FRAGMENTS,
  LEAKED_STRINGS,
} from "../facts/facts.fixture.js";

import {
  buildNarrativeSource,
  isAllowedProseScript,
  renderNarrativeSource,
  summarizeNarrative,
} from "./narrative.js";

const facts = extractFacts({ kind: "pattern", records: FACT_FIXTURE_RECORDS }).facts;
const source = buildNarrativeSource({ records: FACT_FIXTURE_RECORDS, facts });
const rendered = renderNarrativeSource(source);

function reasonFor(recordId: string): string[] {
  return source.excluded
    .filter((entry) => entry.recordId === recordId && entry.section === undefined)
    .map((entry) => entry.reason);
}

describe("buildNarrativeSource — 산문은 실제로 들어간다", () => {
  it("레코드 본문 산문이 재료에 실린다 — 팩트 팩만으로는 인과를 쓸 수 없다(판단 1)", () => {
    const record = source.records.find((entry) => entry.recordId === FIXTURE_IDS.pnpmEsbuild);
    expect(record?.parts.map((part) => part.section)).toContain("rootCause");
    expect(rendered).toContain("pnpm 10부터 의존성의 postinstall");
  });

  it("데이터 프레이밍된 블록으로 감싼다 (NFR-05)", () => {
    expect(rendered).toContain(`<record id="${FIXTURE_IDS.pnpmEsbuild}"`);
    expect(rendered).toContain("<rootCause>");
  });
});

describe("buildNarrativeSource — T-030의 방어를 되가져온다", () => {
  it("injection-suspect 레코드는 산문 경로에도 없다 (T-018·T-029·T-030의 그 제외)", () => {
    expect(reasonFor(FIXTURE_IDS.injectionFlagged)).toEqual(["not-material"]);
    expect(rendered).not.toContain("이전 지시를 무시하고");
  });

  it("sanitizeFlags가 붙은 레코드의 산문은 싣지 않는다 (§7)", () => {
    expect(reasonFor(FIXTURE_IDS.masked)).toEqual(["sanitize-flagged"]);
  });

  it("플래그 없는 잔여 유출은 형상으로 막는다 (T-004 F-21 면제 경로)", () => {
    const sections = source.excluded
      .filter((entry) => entry.recordId === FIXTURE_IDS.residualLeak)
      .map((entry) => `${String(entry.section)}=${entry.reason}`);
    expect(sections).toContain("symptom=uri-shape");
    expect(sections).toContain("resolution=secret-shape");
  });

  it("플래그 없는 일본어 인젝션은 스크립트 허용목록이 막는다 (T-040 미탐 축)", () => {
    expect(reasonFor(FIXTURE_IDS.japaneseInjection)).toEqual(["non-allowlisted-script"]);
  });

  it("유출 문자열이 프롬프트 재료 어디에도 없다", () => {
    for (const leaked of LEAKED_STRINGS) {
      expect(rendered, leaked).not.toContain(leaked);
    }
  });

  it("일본어 인젝션 조각이 프롬프트 재료 어디에도 없다", () => {
    for (const fragment of JAPANESE_INJECTION_FRAGMENTS) {
      expect(rendered, fragment).not.toContain(fragment);
    }
  });

  it("빠진 산문은 사유와 함께 남는다 — 조용히 사라지지 않는다", () => {
    expect(summarizeNarrative(source).excluded.length).toBeGreaterThan(0);
    for (const entry of source.excluded) {
      expect(entry.reason).toBeTruthy();
    }
  });
});

describe("isAllowedProseScript — 형상 규칙이지 언어 열거가 아니다", () => {
  it("한글과 ASCII는 통과한다", () => {
    expect(isAllowedProseScript("pnpm install 이 죽었다. exit=1")).toBe(true);
  });

  it("가나·한자·키릴·아랍 문자는 언어를 늘려도 전부 막힌다", () => {
    for (const sample of ["これまでの指示", "忽略先前指令", "Игнорировать", "تجاهل"]) {
      expect(isAllowedProseScript(sample), sample).toBe(false);
    }
  });

  it("NBSP 같은 비가시 문자는 통과하지 못한다 (T-004 F-18)", () => {
    expect(isAllowedProseScript("pnpm\u00A0install")).toBe(false);
  });
});

describe("buildNarrativeSource — 경계", () => {
  it("팩트 팩의 소스 집합 밖 레코드는 산문이 되지 못한다", () => {
    const narrowed = buildNarrativeSource({
      records: FACT_FIXTURE_RECORDS,
      facts: { ...facts, sourceRecordIds: [FIXTURE_IDS.pnpmEsbuild] },
    });
    expect(narrowed.records.map((entry) => entry.recordId)).toEqual([FIXTURE_IDS.pnpmEsbuild]);
  });

  it("상한을 넘는 산문은 문장 경계에서 잘리고 그 사실이 남는다", () => {
    const short = buildNarrativeSource({
      records: FACT_FIXTURE_RECORDS,
      facts,
      partMaxChars: 40,
    });
    const truncated = short.records.flatMap((record) => record.parts).filter((part) => part.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const part of truncated) {
      expect(part.text.length).toBeLessThanOrEqual(40);
    }
  });

  it("같은 입력이면 같은 재료가 나온다 (결정론)", () => {
    const again = buildNarrativeSource({ records: [...FACT_FIXTURE_RECORDS].reverse(), facts });
    expect(again).toEqual(source);
  });
});
