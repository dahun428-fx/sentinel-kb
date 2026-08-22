/**
 * 레코드 본문을 화면에 뿌릴 섹션 목록으로 편다.
 *
 * 인용·검색 결과가 `ChunkSection`으로 특정 섹션을 가리키므로(specs/02 chunks.section),
 * 상세 화면의 섹션 앵커도 같은 열거값을 써야 점프가 성립한다. 그 대응을 여기서 한 번만 정한다.
 */
import type { ChunkSection, RecordSchema } from "@sentinel/contracts";

import { DIVERGENCE_SECTIONS, INCIDENT_SECTIONS } from "./display";

export interface RecordSectionView {
  readonly section: ChunkSection;
  readonly text: string;
}

/**
 * 존재하는 섹션만 표시 순서대로 돌려준다.
 * `rootCause`·`prevention`은 contracts에서 optional이므로 빠질 수 있고,
 * 빈 문자열도 섹션을 만들지 않는다 — 제목만 있고 내용이 없는 칸은 오해를 만든다.
 */
export function recordSections(record: RecordSchema): RecordSectionView[] {
  const order: readonly ChunkSection[] =
    record.type === "incident" ? INCIDENT_SECTIONS : DIVERGENCE_SECTIONS;

  const source: Partial<Record<ChunkSection, string | undefined>> =
    record.type === "incident"
      ? {
          symptom: record.symptom,
          rootCause: record.rootCause,
          resolution: record.resolution,
          prevention: record.prevention,
        }
      : {
          expected: record.expected,
          actual: record.actual,
          correction: record.correction,
        };

  const views: RecordSectionView[] = [];
  for (const section of order) {
    const text = source[section];
    if (text !== undefined && text.trim() !== "") {
      views.push({ section, text });
    }
  }
  return views;
}
