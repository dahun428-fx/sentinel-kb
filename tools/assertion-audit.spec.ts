/**
 * T-041 자기충족 단언 래칫.
 *
 * 이 스위트는 **테스트를 테스트한다.** 새 `*.spec.ts`가 import한 상수를 기대값으로 쓰면
 * 여기서 걸리고, 작성자는 세 레지스트리 중 하나에 **사유와 함께** 넣어야 한다.
 * 분류를 강제하는 것이 목적이지 패턴을 금지하는 것이 목적이 아니다 —
 * 실측으로 후보의 대부분이 정당했다(T-041).
 */
import { describe, expect, it } from "vitest";

import {
  BEHAVIOURALLY_ANCHORED,
  LITERAL_ANCHOR_REQUIRED,
  SYMBOLIC_CONSTANTS,
  doublyClassifiedConstants,
  mirrorOnlyBehaviourallyAnchored,
  mirrorOnlyConstants,
  missingLiteralAnchors,
  scanImportedConstantAssertions,
  unclassifiedConstants,
} from "./assertion-audit.js";

const findings = scanImportedConstantAssertions();

describe("자기충족 단언 스캐너", () => {
  it("스위트에서 후보를 실제로 찾아낸다 — 0건이면 스캐너가 고장 난 것이다", () => {
    // 하한만 잠근다. 정확한 수를 박으면 테스트를 추가할 때마다 여기가 깨진다.
    expect(findings.length).toBeGreaterThan(20);
    expect(findings.flatMap((finding) => finding.sites).length).toBeGreaterThan(80);
  });

  it("픽스처에서 온 기대값은 후보가 아니다 (판정 기준 C1)", () => {
    // `*.fixture.ts`·`vitest`·`node:*`는 제외된다. 테스트가 만든 값은 자기충족이 아니다.
    const fromFixtures = findings.filter((finding) =>
      finding.modules.some(
        (module) => module.includes(".fixture") || module === "vitest" || module.startsWith("node:"),
      ),
    );
    expect(fromFixtures).toEqual([]);
  });
});

/**
 * T-043: `{상수, 그 상수의 문서 거울}` 쌍.
 *
 * 스캐너가 `toContain`/템플릿 보간 형태를 **거울 대조**로 따로 세고, 거울밖에 없는 상수를
 * "행동으로 잠김"이라 주장하면 래칫이 막는다. T-041 레지스트리의 거짓 근거 다섯 중 둘이
 * 정확히 이 착각이었다(`RETRIEVAL_DEFAULTS`는 `.env.example` 거울, `TARGET_RECORDS_4W`는
 * specs/00 거울이 유일한 killer였다).
 */
describe("거울 대조 스캔 (T-043)", () => {
  it("맨 식별자가 아닌 보간 형태를 잡는다 — T-041 스캐너의 사각지대", () => {
    const byName = new Map(findings.map((finding) => [finding.constant, finding]));

    // `expect(envExample).toContain(`\n${name}=${String(value)}\n`)` — 루프 변수로 갈아탔다.
    const retrieval = byName.get("RETRIEVAL_DEFAULTS");
    expect(retrieval?.mirrorSites.map((site) => site.file)).toContain(
      "packages/core/src/retriever/config.spec.ts",
    );

    // `expect(target).toContain(String(TARGET_RECORDS_4W))` — 직접 보간.
    const target = byName.get("TARGET_RECORDS_4W");
    expect(target?.mirrorSites.map((site) => site.file)).toContain("tools/harvest-docs.spec.ts");
  });

  it("거울 전용 상수가 실재한다 — 0건이면 이 래칫이 공허하다", () => {
    // 지금 레포에는 문서 거울로만 확인되는 상수가 여럿 있다(`TARGET_HITS_4W` 등).
    expect(mirrorOnlyConstants(findings).length).toBeGreaterThan(0);
    expect(mirrorOnlyConstants(findings)).toContain("TARGET_HITS_4W");
  });

  it("거울 대조만 있는 상수는 '행동으로 잠김'이 아니다", () => {
    /*
     * 깨졌다면: 여기 나온 상수의 근거가 **거짓**이다. 좌변이 문서고 우변이 상수라,
     * 상수와 문서를 같은 커밋에서 옮기면 스위트가 그대로 초록이 된다.
     * `LITERAL_ANCHOR_REQUIRED`로 옮기고 리터럴 앵커를 달아라.
     */
    expect(mirrorOnlyBehaviourallyAnchored(findings)).toEqual([]);
  });
});

describe("분류 래칫 (T-041 Acceptance A2)", () => {
  it("모든 후보 상수가 세 레지스트리 중 하나에 있다", () => {
    /*
     * 깨졌다면: 새 단언이 import한 상수를 기대값으로 쓴다.
     * 그 상수를 바꿔 보고(뮤테이션) 테스트가 죽는지 확인한 뒤 넣어라.
     *   - 안 죽는데 스펙이 값을 정했다 → LITERAL_ANCHOR_REQUIRED + 리터럴 앵커 단언 추가
     *   - 죽는다                      → BEHAVIOURALLY_ANCHORED + 뮤턴트와 사망 건수 기록
     *   - 크기가 아니라 이름이다      → SYMBOLIC_CONSTANTS + 사유
     */
    expect(unclassifiedConstants(findings)).toEqual([]);
  });

  it("한 상수가 두 레지스트리에 동시에 있지 않다", () => {
    expect(doublyClassifiedConstants()).toEqual([]);
  });

  it("모든 분류에 사유가 적혀 있다 — 빈 문자열은 분류가 아니다", () => {
    for (const registry of [LITERAL_ANCHOR_REQUIRED, BEHAVIOURALLY_ANCHORED, SYMBOLIC_CONSTANTS]) {
      for (const [name, reason] of Object.entries(registry)) {
        expect(reason.trim().length, name).toBeGreaterThan(10);
      }
    }
  });
});

describe("리터럴 앵커 (T-041 Acceptance A3)", () => {
  it("앵커가 필요한 상수에 전부 앵커가 있다", () => {
    /*
     * 깨졌다면: 누군가 계약 앵커 단언을 지웠다. **되살려라.**
     * 앵커가 없으면 그 상수를 바꾸는 것이 게이트를 통과하는 가장 싼 길이 된다 —
     * T-003·T-014·T-031이 정확히 그렇게 뚫렸다.
     */
    expect(missingLiteralAnchors(findings)).toEqual([]);
  });

  it("NFR 상한 둘이 앵커 목록에 있다 — 이 태스크가 연 자리다", () => {
    expect(Object.keys(LITERAL_ANCHOR_REQUIRED)).toContain("MCP_SEARCH_TOKEN_BUDGET");
    expect(Object.keys(LITERAL_ANCHOR_REQUIRED)).toContain("NFR01_SEARCH_P95_MS");
  });
});
