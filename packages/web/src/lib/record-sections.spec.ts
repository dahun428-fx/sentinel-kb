import type { RecordSchema, Relation, SanitizeFlag, Severity } from "@sentinel/contracts";
import { describe, expect, it } from "vitest";

import { recordSections } from "./record-sections";

const BASE = {
  _id: "0123456789abcdef01234567",
  project: "sentinel-kb",
  title: "결제 웹훅 타임아웃",
  summary: "요약",
  severity: "SEV2" as Severity,
  tags: [] as string[],
  sanitizeFlags: [] as SanitizeFlag[],
  relations: [] as Relation[],
  status: "published" as const,
  embeddingVersion: 1,
  createdAt: new Date("2026-08-21T00:00:00.000Z"),
  updatedAt: new Date("2026-08-21T00:00:00.000Z"),
};

describe("recordSections", () => {
  it("incident는 증상 → 원인 → 해결 → 방지 순서다", () => {
    const record: RecordSchema = {
      ...BASE,
      type: "incident",
      symptom: "504",
      rootCause: "동기 처리",
      resolution: "큐 분리",
      prevention: "타임아웃 알람",
    };
    expect(recordSections(record).map((view) => view.section)).toEqual([
      "symptom",
      "rootCause",
      "resolution",
      "prevention",
    ]);
  });

  it("optional 섹션이 비면 칸을 만들지 않는다", () => {
    const record: RecordSchema = {
      ...BASE,
      type: "incident",
      symptom: "504",
      resolution: "큐 분리",
    };
    expect(recordSections(record).map((view) => view.section)).toEqual(["symptom", "resolution"]);
  });

  it("공백만 있는 섹션도 제외한다 — 제목만 있고 내용 없는 칸은 오해를 만든다", () => {
    const record: RecordSchema = {
      ...BASE,
      type: "incident",
      symptom: "504",
      rootCause: "   ",
      resolution: "큐 분리",
    };
    expect(recordSections(record).map((view) => view.section)).toEqual(["symptom", "resolution"]);
  });

  it("divergence는 기대 → 실제 → 교정 순서다", () => {
    const record: RecordSchema = {
      ...BASE,
      type: "divergence",
      expected: "스펙대로",
      actual: "환각 API",
      context: { model: "opus" },
      correction: "계약 먼저 읽힌다",
    };
    expect(recordSections(record).map((view) => view.section)).toEqual([
      "expected",
      "actual",
      "correction",
    ]);
  });
});
