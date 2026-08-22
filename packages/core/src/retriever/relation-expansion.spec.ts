/**
 * 관계 확장의 **순수 규칙** 단위 테스트 (T-035, specs/03 §2.5).
 *
 * 여기서 잠그는 것은 뮤테이션 표의 다음 항목들이다 — 각 `it`이 그 뮤테이션 하나를 죽인다:
 *  - 1홉 제한 제거          → `maxDepth`가 0이 아니면 `$graphLookup` 형상 테스트가 죽는다
 *  - +3청크 상한 무시        → `selectExpansionChunks`의 상한 테스트가 죽는다
 *  - 순환 참조 무한 루프      → A↔B 픽스처 테스트가 죽는다(그리고 `int` 쪽이 실제 엔진으로 확인한다)
 *  - 확장 대상 관계 종류 확대 → `related`/`corrects` 제외 테스트가 죽는다
 *
 * `$graphLookup`이 **실제로** 1홉만 도는지는 이 파일이 증명할 수 없다(엔진 동작이다).
 * 그 판정은 `relation-expansion.int.spec.ts`가 atlas-local 컨테이너에서 한다.
 * 여기서는 "우리가 발행하는 파이프라인이 그것을 요구한다"까지만 잠근다.
 */
import { describe, expect, it } from "vitest";

import {
  EXPANDABLE_RELATION_TYPES,
  EXPANDED_SECTIONS,
  MAX_RELATION_CHUNKS,
  RELATION_GRAPH_MAX_DEPTH,
  RELATION_TARGETS_FIELD,
  buildRelationChunkPipeline,
  buildRelationLookupPipeline,
  parseRelationTargets,
  selectExpansionChunks,
  type ExpandableCandidate,
  type RelationTarget,
} from "./relation-expansion.js";
import type { PipelineStage } from "./types.js";

const ENTRY_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ENTRY_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET_X = "xxxxxxxxxxxxxxxxxxxxxxxx";
const TARGET_Y = "yyyyyyyyyyyyyyyyyyyyyyyy";
const GONE = "dddddddddddddddddddddddd";

/** 테스트에서 id는 문자열 그대로다 — 실제로는 `ObjectId`가 온다. */
const toId = (value: unknown): string => String(value);

function lookupDoc(
  id: string,
  relations: readonly { type: string; targetRecordId: string }[],
  /** `$graphLookup`이 **실제로 찾아낸** 대상. 삭제된 대상은 여기 없다. */
  found: readonly string[],
): Record<string, unknown> {
  return {
    _id: id,
    relations: relations.map((relation) => ({ ...relation })),
    [RELATION_TARGETS_FIELD]: found.map((targetId) => ({ _id: targetId })),
  };
}

function candidate(
  chunkId: string,
  recordId: string,
  section: (typeof EXPANDED_SECTIONS)[number],
  seq = 0,
): ExpandableCandidate {
  return { chunkId, recordId, section, seq };
}

function stage(pipeline: PipelineStage[], operator: string): Record<string, unknown> {
  const found = pipeline.find((entry) => operator in entry)?.[operator];
  if (typeof found !== "object" || found === null) {
    throw new Error(`${operator} 스테이지가 없다`);
  }
  return found as Record<string, unknown>;
}

describe("발행되는 $graphLookup 파이프라인", () => {
  const pipeline = buildRelationLookupPipeline([ENTRY_A, ENTRY_B], "records");

  it("maxDepth가 0이다 — 이것이 1홉 제한의 전부다 (Acceptance 4)", () => {
    // 이 값이 1이 되면 2홉이 되고, specs/03 §2.5의 "relations 1홉"이 깨진다.
    expect(RELATION_GRAPH_MAX_DEPTH).toBe(0);
    expect(stage(pipeline, "$graphLookup")["maxDepth"]).toBe(0);
  });

  it("진입점만 시작점으로 삼는다", () => {
    expect(stage(pipeline, "$match")).toEqual({ _id: { $in: [ENTRY_A, ENTRY_B] } });
  });

  it("확장 대상 관계 종류를 **파이프라인 안에서** 좁힌다", () => {
    /*
     * 좁히기가 후처리에만 있으면 후처리 한 줄을 지웠을 때 조용히 넓어진다.
     * `startWith`가 필터된 목록을 map한 결과여야 한다.
     */
    const project = stage(pipeline, "$project");
    expect(JSON.stringify(project)).toContain("recurrence_of");
    expect(JSON.stringify(project)).toContain("same_root_cause");
    expect(JSON.stringify(project)).not.toContain("corrects");

    const lookup = stage(pipeline, "$graphLookup");
    expect(lookup["startWith"]).toEqual({
      $map: { input: "$relations", as: "relation", in: "$$relation.targetRecordId" },
    });
  });

  it("대상 레코드의 본문을 끌어오지 않는다 — _id만 투영한다", () => {
    const last = pipeline[pipeline.length - 1];
    expect(last?.["$project"]).toEqual({
      relations: 1,
      [`${RELATION_TARGETS_FIELD}._id`]: 1,
    });
  });

  it("specs/03 §2.5가 지목한 두 관계만 확장한다", () => {
    expect([...EXPANDABLE_RELATION_TYPES]).toEqual(["recurrence_of", "same_root_cause"]);
  });
});

describe("발행되는 확장 청크 파이프라인", () => {
  const pipeline = buildRelationChunkPipeline([TARGET_X], 7, { _id: 1, text: 1 });

  it("resolution·prevention 섹션만, 같은 임베딩 세대만 긁는다", () => {
    expect(stage(pipeline, "$match")).toEqual({
      recordId: { $in: [TARGET_X] },
      section: { $in: ["resolution", "prevention"] },
      embeddingVersion: 7,
    });
  });

  it("확장 청크의 점수는 0으로 투영된다 — 융합 순위가 없다는 뜻이다", () => {
    expect(stage(pipeline, "$project")).toEqual({ _id: 1, text: 1, score: { $literal: 0 } });
  });

  it("resolution이 prevention보다 우선순위가 높다", () => {
    expect([...EXPANDED_SECTIONS]).toEqual(["resolution", "prevention"]);
  });
});

describe("parseRelationTargets", () => {
  it("확장 대상 관계만 남긴다", () => {
    const targets = parseRelationTargets(
      [
        lookupDoc(
          ENTRY_A,
          [
            { type: "recurrence_of", targetRecordId: TARGET_X },
            { type: "related", targetRecordId: TARGET_Y },
            { type: "corrects", targetRecordId: TARGET_Y },
          ],
          [TARGET_X, TARGET_Y],
        ),
      ],
      [ENTRY_A],
      toId,
    );

    expect(targets).toEqual([
      {
        fromRecordId: ENTRY_A,
        type: "recurrence_of",
        targetRecordId: TARGET_X,
        targetRecordIdRaw: TARGET_X,
      },
    ]);
  });

  /**
   * T-011 F-11(고아 청크를 조용히 뺀다)과 **같은 처리**다. 관계가 끊어진 것은 검색 실패가
   * 아니므로 던지지 않는다 — 진입점의 hit은 그대로 유효하고 확장만 일어나지 않는다.
   */
  it("삭제된 대상을 가리키는 관계는 조용히 뺀다", () => {
    const targets = parseRelationTargets(
      [
        lookupDoc(
          ENTRY_A,
          [
            { type: "recurrence_of", targetRecordId: GONE },
            { type: "same_root_cause", targetRecordId: TARGET_X },
          ],
          // $graphLookup이 GONE을 찾지 못했다 = 그 레코드가 없다.
          [TARGET_X],
        ),
      ],
      [ENTRY_A],
      toId,
    );

    expect(targets.map((t) => t.targetRecordId)).toEqual([TARGET_X]);
  });

  it("자기 자신을 가리키는 관계(A→A)를 끊는다", () => {
    const targets = parseRelationTargets(
      [lookupDoc(ENTRY_A, [{ type: "recurrence_of", targetRecordId: ENTRY_A }], [ENTRY_A])],
      [ENTRY_A],
      toId,
    );
    expect(targets).toEqual([]);
  });

  it("같은 엣지가 중복 선언돼도 한 번만 남는다", () => {
    const targets = parseRelationTargets(
      [
        lookupDoc(
          ENTRY_A,
          [
            { type: "recurrence_of", targetRecordId: TARGET_X },
            { type: "recurrence_of", targetRecordId: TARGET_X },
          ],
          [TARGET_X],
        ),
      ],
      [ENTRY_A],
      toId,
    );
    expect(targets).toHaveLength(1);
  });

  /**
   * 상한이 +3이므로 **무엇이 잘리는지가 순서에 달려 있다.** 순서가 흔들리면 같은 질의가
   * 호출마다 다른 컨텍스트를 받아 eval의 on/off 비교가 잡음을 잰다.
   */
  it("진입점 순위 → 관계 종류 → 대상 id 순으로 결정론이다", () => {
    const docs = [
      // 일부러 진입점 순위와 반대로 넣는다. $match {$in}은 순서를 보장하지 않는다.
      lookupDoc(
        ENTRY_B,
        [{ type: "recurrence_of", targetRecordId: TARGET_X }],
        [TARGET_X],
      ),
      lookupDoc(
        ENTRY_A,
        [
          { type: "same_root_cause", targetRecordId: TARGET_Y },
          { type: "recurrence_of", targetRecordId: TARGET_Y },
        ],
        [TARGET_Y],
      ),
    ];

    const targets = parseRelationTargets(docs, [ENTRY_A, ENTRY_B], toId);
    expect(targets.map((t) => [t.fromRecordId, t.type])).toEqual([
      [ENTRY_A, "recurrence_of"],
      [ENTRY_A, "same_root_cause"],
      [ENTRY_B, "recurrence_of"],
    ]);
  });

  /**
   * A→B, B→A. `parseRelationTargets`는 `$graphLookup`이 준 것을 접을 뿐 스스로 순회하지
   * 않으므로 **구조적으로** 돌 수 없다. 실제 엔진 동작은 int 테스트가 확인한다.
   */
  it("순환 관계(A↔B)에서도 유한하게 끝난다 (Acceptance 4)", () => {
    const targets = parseRelationTargets(
      [
        lookupDoc(ENTRY_A, [{ type: "recurrence_of", targetRecordId: ENTRY_B }], [ENTRY_B]),
        lookupDoc(ENTRY_B, [{ type: "recurrence_of", targetRecordId: ENTRY_A }], [ENTRY_A]),
      ],
      [ENTRY_A, ENTRY_B],
      toId,
    );

    expect(targets.map((t) => [t.fromRecordId, t.targetRecordId])).toEqual([
      [ENTRY_A, ENTRY_B],
      [ENTRY_B, ENTRY_A],
    ]);
  });
});

describe("selectExpansionChunks", () => {
  const targets: RelationTarget[] = [
    {
      fromRecordId: ENTRY_A,
      type: "recurrence_of",
      targetRecordId: TARGET_X,
      targetRecordIdRaw: TARGET_X,
    },
    {
      fromRecordId: ENTRY_B,
      type: "same_root_cause",
      targetRecordId: TARGET_Y,
      targetRecordIdRaw: TARGET_Y,
    },
  ];

  it("specs/03 §2.5의 상한은 3이다", () => {
    expect(MAX_RELATION_CHUNKS).toBe(3);
  });

  it("상한을 절대 넘지 않는다 (뮤테이션: +3청크 상한 무시)", () => {
    const candidates = [
      candidate("c1", TARGET_X, "resolution", 0),
      candidate("c2", TARGET_X, "resolution", 1),
      candidate("c3", TARGET_X, "prevention", 0),
      candidate("c4", TARGET_Y, "resolution", 0),
      candidate("c5", TARGET_Y, "prevention", 0),
    ];

    const picks = selectExpansionChunks(candidates, targets, new Set(), MAX_RELATION_CHUNKS);
    expect(picks).toHaveLength(MAX_RELATION_CHUNKS);
    expect(picks.map((p) => p.candidate.chunkId)).toEqual(["c1", "c2", "c3"]);
  });

  it("resolution을 prevention보다 먼저 남긴다", () => {
    const picks = selectExpansionChunks(
      [candidate("p", TARGET_X, "prevention", 0), candidate("r", TARGET_X, "resolution", 9)],
      targets,
      new Set(),
      1,
    );
    expect(picks.map((p) => p.candidate.chunkId)).toEqual(["r"]);
  });

  it("출처 관계를 붙여 돌려준다 (§2.5 '출처 관계를 인용에 표기')", () => {
    const picks = selectExpansionChunks(
      [candidate("c1", TARGET_X, "resolution"), candidate("c4", TARGET_Y, "resolution")],
      targets,
      new Set(),
      MAX_RELATION_CHUNKS,
    );
    expect(picks.map((p) => p.relation)).toEqual([
      { type: "recurrence_of", fromRecordId: ENTRY_A },
      { type: "same_root_cause", fromRecordId: ENTRY_B },
    ]);
  });

  it("이미 검색 결과에 있는 청크는 다시 싣지 않는다", () => {
    const picks = selectExpansionChunks(
      [candidate("c1", TARGET_X, "resolution"), candidate("c2", TARGET_X, "prevention")],
      targets,
      new Set(["c1"]),
      MAX_RELATION_CHUNKS,
    );
    expect(picks.map((p) => p.candidate.chunkId)).toEqual(["c2"]);
  });

  it("두 진입점이 같은 대상을 가리켜도 청크는 한 번만 실린다", () => {
    const sameTarget: RelationTarget[] = [
      targets[0] as RelationTarget,
      { ...(targets[1] as RelationTarget), targetRecordId: TARGET_X, targetRecordIdRaw: TARGET_X },
    ];
    const picks = selectExpansionChunks(
      [candidate("c1", TARGET_X, "resolution")],
      sameTarget,
      new Set(),
      MAX_RELATION_CHUNKS,
    );
    expect(picks).toHaveLength(1);
    // 출처는 먼저 온 쪽(=상위 진입점)이다.
    expect(picks[0]?.relation.fromRecordId).toBe(ENTRY_A);
  });

  it("max가 0 이하면 아무것도 고르지 않는다", () => {
    expect(
      selectExpansionChunks([candidate("c1", TARGET_X, "resolution")], targets, new Set(), 0),
    ).toEqual([]);
  });
});
