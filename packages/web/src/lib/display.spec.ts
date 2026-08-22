import { describe, expect, it } from "vitest";

import {
  DEFAULT_RRF_K,
  flagNotices,
  formatFusionScore,
  fusionScoreCeiling,
  FUSION_SCORE_NOTE,
  hasInjectionSuspect,
  rankLabel,
  recordSectionHref,
  sectionAnchorId,
  sectionLabel,
  severityLabel,
  typeLabel,
} from "./display";

describe("RRF 점수 표기", () => {
  it("RRF_K=60에서 상한은 2/61 ≈ 0.0328이다", () => {
    expect(fusionScoreCeiling(DEFAULT_RRF_K)).toBeCloseTo(2 / 61, 12);
    expect(fusionScoreCeiling(DEFAULT_RRF_K)).toBeLessThan(0.034);
  });

  it("점수를 백분율로 바꾸지 않는다 — 상한이 3%대라 '3% 일치'로 읽히면 검색이 망가진 것처럼 보인다", () => {
    const ceiling = fusionScoreCeiling();
    expect(formatFusionScore(ceiling)).not.toContain("%");
    expect(formatFusionScore(ceiling)).toBe("RRF 0.0328");
  });

  it("척도 이름을 항상 붙인다", () => {
    expect(formatFusionScore(0.0164)).toBe("RRF 0.0164");
    expect(formatFusionScore(Number.NaN)).toBe("RRF —");
  });

  it("사용자가 읽는 주 지표는 순위다", () => {
    expect(rankLabel(0)).toBe("1위");
    expect(rankLabel(4)).toBe("5위");
  });

  it("표기 근거 문구가 유사도가 아님을 밝힌다", () => {
    expect(FUSION_SCORE_NOTE).toContain("RRF");
    expect(FUSION_SCORE_NOTE).toContain("유사도");
    expect(FUSION_SCORE_NOTE).not.toContain("%");
  });
});

describe("새니타이즈 플래그 경고", () => {
  it("injection-suspect는 경고 톤으로 노출된다 (specs/03 §2: 목록에는 경고와 함께)", () => {
    const notices = flagNotices(["injection-suspect"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.tone).toBe("warning");
    expect(notices[0]?.description).toContain("데이터");
    expect(hasInjectionSuspect(["injection-suspect"])).toBe(true);
  });

  it("secret-masked는 정보 톤이다 — 경고 인플레이션을 만들지 않는다", () => {
    const notices = flagNotices(["secret-masked"]);
    expect(notices[0]?.tone).toBe("info");
  });

  it("두 플래그가 함께 오면 인젝션 경고가 먼저 온다", () => {
    const notices = flagNotices(["secret-masked", "injection-suspect"]);
    expect(notices.map((notice) => notice.flag)).toEqual(["injection-suspect", "secret-masked"]);
  });

  it("플래그가 없으면 경고도 없다", () => {
    expect(flagNotices([])).toEqual([]);
    expect(hasInjectionSuspect([])).toBe(false);
  });
});

describe("인용 점프 링크", () => {
  it("검색 결과와 인용이 같은 앵커 규칙을 쓴다", () => {
    expect(sectionAnchorId("resolution")).toBe("section-resolution");
    expect(recordSectionHref("0123456789abcdef01234567", "resolution")).toBe(
      "/records/0123456789abcdef01234567#section-resolution",
    );
  });

  it("섹션이 없으면 레코드 최상단으로 간다", () => {
    expect(recordSectionHref("0123456789abcdef01234567")).toBe(
      "/records/0123456789abcdef01234567",
    );
  });
});

describe("라벨", () => {
  it("섹션·종류·심각도에 한국어 라벨이 있다", () => {
    expect(sectionLabel("symptom")).toBe("증상");
    expect(sectionLabel("correction")).toBe("교정");
    expect(typeLabel("divergence")).toBe("이격");
    expect(severityLabel("SEV1")).toContain("SEV1");
  });
});
