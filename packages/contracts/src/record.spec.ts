import { describe, expect, it } from "vitest";

import {
  CreateRecordInput,
  DivergenceInput,
  IncidentInput,
  PatchRecordInput,
  RecordSchema,
  RecordSummary,
} from "./record.js";
import { without } from "./spec-helpers.js";

const VALID_INCIDENT = {
  type: "incident" as const,
  title: "MCP 서버 504 게이트웨이 타임아웃",
  symptom: "search_knowledge 호출이 30초 후 504로 실패한다",
  resolution: "nginx proxy_read_timeout을 120s로 올리고 keepalive 설정 추가",
};

const VALID_DIVERGENCE = {
  type: "divergence" as const,
  title: "에이전트가 스펙에 없는 MCP 도구를 추가함",
  expected: "specs/07에 정의된 도구 5개만 등록되어야 한다",
  actual: "에이전트가 list_projects 도구를 임의로 6번째로 추가했다",
  correction: "CLAUDE.md 금지 사항에 도구 개수 상한을 명시하고 eval에 케이스 추가",
};

describe("CreateRecordInput", () => {
  it("유효한 incident 입력을 파싱한다", () => {
    expect(CreateRecordInput.safeParse(VALID_INCIDENT).success).toBe(true);
  });

  it("유효한 divergence 입력을 파싱한다", () => {
    expect(CreateRecordInput.safeParse(VALID_DIVERGENCE).success).toBe(true);
  });

  it("severity와 tags에 기본값을 채운다", () => {
    const parsed = CreateRecordInput.parse(VALID_INCIDENT);
    expect(parsed.severity).toBe("NOTE");
    expect(parsed.tags).toEqual([]);
  });

  /**
   * specs/03 §1-1이 embed job을 `published` 저장에 걸어두었다.
   * 기본이 draft면 MCP record_knowledge로 들어온 레코드가 영원히 임베딩되지 않고
   * T-008 워커가 할 일이 없어진다.
   */
  it("status 기본값은 published다 — 즉시 검색 가능해야 한다 (specs/03 §1-1)", () => {
    expect(CreateRecordInput.parse(VALID_INCIDENT).status).toBe("published");
    expect(CreateRecordInput.parse(VALID_DIVERGENCE).status).toBe("published");
  });

  it("draft를 명시하면 그대로 통과한다 — 포스트모템 위저드용 예외 (FR-09)", () => {
    expect(
      CreateRecordInput.parse({ ...VALID_INCIDENT, status: "draft" }).status,
    ).toBe("draft");
  });

  it("정의되지 않은 status는 거부한다", () => {
    expect(
      CreateRecordInput.safeParse({ ...VALID_INCIDENT, status: "archived" }).success,
    ).toBe(false);
  });

  // T-002 Acceptance 1
  it.each(["expected", "actual", "correction"])(
    "incident에 divergence 전용 필드 %s를 넣으면 파싱에 실패한다",
    (field) => {
      const result = CreateRecordInput.safeParse({
        ...VALID_INCIDENT,
        [field]: "여기 있으면 안 되는 값이다",
      });
      expect(result.success).toBe(false);
    },
  );

  it("divergence에 incident 전용 필드를 넣어도 파싱에 실패한다", () => {
    const result = CreateRecordInput.safeParse({
      ...VALID_DIVERGENCE,
      symptom: "여기 있으면 안 되는 값이다",
    });
    expect(result.success).toBe(false);
  });

  // T-002 Acceptance 2
  it.each(["expected", "actual", "correction"])(
    "divergence에서 %s가 누락되면 파싱에 실패한다",
    (field) => {
      expect(CreateRecordInput.safeParse(without(VALID_DIVERGENCE, field)).success).toBe(
        false,
      );
    },
  );

  it.each(["symptom", "resolution"])(
    "incident에서 %s가 누락되면 파싱에 실패한다",
    (field) => {
      expect(CreateRecordInput.safeParse(without(VALID_INCIDENT, field)).success).toBe(
        false,
      );
    },
  );

  it("알 수 없는 type은 거부한다", () => {
    expect(
      CreateRecordInput.safeParse({ ...VALID_INCIDENT, type: "postmortem" })
        .success,
    ).toBe(false);
  });

  it("project는 서버가 주입하므로 바디로 받지 않는다", () => {
    expect(
      CreateRecordInput.safeParse({ ...VALID_INCIDENT, project: "sentinel-kb" })
        .success,
    ).toBe(false);
  });

  /** summary도 서버 생성 필드다(첫 2문장 또는 LLM 요약 캐시). 클라이언트가 넣으면 거부된다. */
  it("summary는 서버가 생성하므로 바디로 받지 않는다", () => {
    expect(
      CreateRecordInput.safeParse({ ...VALID_INCIDENT, summary: "내가 쓴 요약" }).success,
    ).toBe(false);
  });

  it("title 길이 경계를 강제한다", () => {
    expect(IncidentInput.safeParse({ ...VALID_INCIDENT, title: "짧음" }).success).toBe(
      false,
    );
    expect(
      IncidentInput.safeParse({ ...VALID_INCIDENT, title: "a".repeat(201) }).success,
    ).toBe(false);
  });

  it("tags는 20개를 넘을 수 없다", () => {
    expect(
      DivergenceInput.safeParse({
        ...VALID_DIVERGENCE,
        tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`),
      }).success,
    ).toBe(false);
  });
});

describe("PatchRecordInput", () => {
  it("일부 필드만 보내도 통과한다", () => {
    expect(PatchRecordInput.safeParse({ status: "published" }).success).toBe(true);
  });

  it("빈 객체는 거부한다", () => {
    expect(PatchRecordInput.safeParse({}).success).toBe(false);
  });

  it("type 변경은 거부한다", () => {
    expect(
      PatchRecordInput.safeParse({ type: "divergence", title: "제목 변경" }).success,
    ).toBe(false);
  });

  it("project 변경은 거부한다", () => {
    expect(PatchRecordInput.safeParse({ project: "other-project" }).success).toBe(
      false,
    );
  });

  it("_id 변경은 거부한다", () => {
    expect(
      PatchRecordInput.safeParse({ _id: "0123456789abcdef01234567" }).success,
    ).toBe(false);
  });
});

describe("RecordSchema", () => {
  const base = {
    _id: "0123456789abcdef01234567",
    project: "sentinel-kb",
    title: "MCP 서버 504 게이트웨이 타임아웃",
    summary: "nginx가 SSE 응답을 버퍼링해 504가 났다. proxy_buffering off로 해결.",
    severity: "SEV2",
    tags: ["mcp", "nginx"],
    sanitizeFlags: ["secret-masked"],
    relations: [
      {
        type: "recurrence_of",
        targetRecordId: "0123456789abcdef01234568",
      },
    ],
    status: "published",
    embeddingVersion: 1,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
  };

  it("저장된 incident 레코드를 파싱한다", () => {
    const result = RecordSchema.safeParse({
      ...base,
      type: "incident",
      symptom: "504",
      resolution: "타임아웃 상향",
    });
    expect(result.success).toBe(true);
  });

  it("저장된 divergence 레코드를 파싱한다", () => {
    const result = RecordSchema.safeParse({
      ...base,
      type: "divergence",
      expected: "도구 5개",
      actual: "도구 6개",
      context: { model: "claude-opus-5" },
      correction: "CLAUDE.md에 상한 명시",
    });
    expect(result.success).toBe(true);
  });

  it("spec에 없는 sanitizeFlag는 거부한다", () => {
    const result = RecordSchema.safeParse({
      ...base,
      sanitizeFlags: ["pii-removed"],
      type: "incident",
      symptom: "504",
      resolution: "타임아웃 상향",
    });
    expect(result.success).toBe(false);
  });

  it("_id가 ObjectId 형식이 아니면 거부한다", () => {
    const result = RecordSchema.safeParse({
      ...base,
      _id: "not-an-object-id",
      type: "incident",
      symptom: "504",
      resolution: "타임아웃 상향",
    });
    expect(result.success).toBe(false);
  });
});

describe("RecordSummary", () => {
  const VALID_SUMMARY = {
    _id: "0123456789abcdef01234567",
    type: "incident",
    project: "sentinel-kb",
    title: "MCP 서버 504 게이트웨이 타임아웃",
    summary: "nginx가 SSE 응답을 버퍼링해 504가 났다. proxy_buffering off로 해결.",
    severity: "SEV2",
    tags: ["mcp", "nginx"],
    sanitizeFlags: ["secret-masked"],
    status: "published",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
  };

  it("본문 없는 요약을 파싱한다", () => {
    expect(RecordSummary.safeParse(VALID_SUMMARY).success).toBe(true);
  });

  /**
   * NFR-03 회귀 방지선. specs/04는 "(본문 포함)"을 단건 조회에만 달았다 —
   * 목록 응답이 본문을 나르기 시작하면 이를 감싸는 MCP 도구가 토큰 예산을 즉시 넘긴다.
   */
  it.each([
    "symptom",
    "rootCause",
    "resolution",
    "prevention",
    "expected",
    "actual",
    "correction",
    "context",
  ])("본문 필드 %s가 들어오면 거부한다 (NFR-03)", (field) => {
    expect(
      RecordSummary.safeParse({ ...VALID_SUMMARY, [field]: "본문이 여기 오면 안 된다" })
        .success,
    ).toBe(false);
  });

  it.each([
    "_id",
    "type",
    "project",
    "title",
    "summary",
    "severity",
    "tags",
    "sanitizeFlags",
    "status",
    "createdAt",
    "updatedAt",
  ])("목록 판단에 필요한 %s는 필수다", (field) => {
    expect(RecordSummary.safeParse(without(VALID_SUMMARY, field)).success).toBe(false);
  });

  /**
   * summary가 빠지면 본문 없는 목록은 판단 근거를 통째로 잃는다 — 제목만 남는다.
   * 위 required 목록에 summary가 들어 있는 것이 NFR-03의 실질을 지키는 지점이다.
   */
  it("summary가 빈 문자열이면 거부한다", () => {
    expect(RecordSummary.safeParse({ ...VALID_SUMMARY, summary: "" }).success).toBe(false);
  });
});
