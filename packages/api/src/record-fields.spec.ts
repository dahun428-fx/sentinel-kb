import { describe, expect, it } from "vitest";

import {
  allowedPatchFields,
  BODY_SECTION_FIELDS,
  isBodySectionField,
  summarySourceField,
} from "./record-fields.js";

/**
 * 기대값은 리터럴이다. `INCIDENT_FIELDS` 같은 구현 상수를 참조하면 상수를 고쳤을 때
 * 기대값이 따라 움직여 종류 교차 방어가 사라져도 테스트가 통과한다(T-002 F-2가 노린 결함).
 */
describe("allowedPatchFields — 종류 교차 방어 (T-002 F-2)", () => {
  it("incident는 divergence 전용 필드를 받지 않는다", () => {
    const allowed = allowedPatchFields("incident");

    for (const field of ["expected", "actual", "context", "correction"]) {
      expect(allowed.has(field)).toBe(false);
    }
    for (const field of ["symptom", "rootCause", "resolution", "prevention"]) {
      expect(allowed.has(field)).toBe(true);
    }
  });

  it("divergence는 incident 전용 필드를 받지 않는다", () => {
    const allowed = allowedPatchFields("divergence");

    for (const field of ["symptom", "rootCause", "resolution", "prevention"]) {
      expect(allowed.has(field)).toBe(false);
    }
    for (const field of ["expected", "actual", "context", "correction"]) {
      expect(allowed.has(field)).toBe(true);
    }
  });

  it("공통 필드는 두 종류 모두 받는다", () => {
    for (const field of ["title", "severity", "tags", "status", "relations"]) {
      expect(allowedPatchFields("incident").has(field)).toBe(true);
      expect(allowedPatchFields("divergence").has(field)).toBe(true);
    }
  });

  it("어느 종류에서도 서버 소유 필드는 받지 않는다", () => {
    for (const field of ["project", "type", "summary", "sanitizeFlags", "embeddingVersion"]) {
      expect(allowedPatchFields("incident").has(field)).toBe(false);
      expect(allowedPatchFields("divergence").has(field)).toBe(false);
    }
  });
});

describe("BODY_SECTION_FIELDS — 재임베딩 트리거", () => {
  it("specs/02 chunks.section 열거와 같은 집합이다", () => {
    expect([...BODY_SECTION_FIELDS]).toEqual([
      "symptom",
      "rootCause",
      "resolution",
      "prevention",
      "expected",
      "actual",
      "correction",
    ]);
  });

  /** `context`는 청크가 되지 않으므로 바꿔도 벡터가 낡지 않는다. */
  it("context는 본문 섹션이 아니다", () => {
    expect(isBodySectionField("context")).toBe(false);
    expect(isBodySectionField("title")).toBe(false);
  });
});

describe("summarySourceField", () => {
  it("incident는 symptom, divergence는 expected다 — 둘 다 그 종류의 필수 필드다", () => {
    expect(summarySourceField("incident")).toBe("symptom");
    expect(summarySourceField("divergence")).toBe("expected");
  });
});
