/**
 * 관계 확장 (경량 GraphRAG). 출처: specs/03-rag-pipeline.md §2.5, ADR-07 단계 0, T-035.
 *
 * > 융합 상위 진입점 레코드의 `relations` 1홉을 `$graphLookup`으로 순회해
 * > `recurrence_of`·`same_root_cause` 대상의 `resolution`/`prevention` 청크를 컨텍스트
 * > 후보에 병합한다(최대 +3청크, 출처 관계를 인용에 표기).
 * > **on/off 플래그로 두고 eval에서 효과를 비교한다 — 지표가 오르지 않으면 확장하지 않는다.**
 *
 * ## 이 모듈은 **순수 함수만** 갖는다
 *
 * 파이프라인을 *만들고*, 돌아온 도큐먼트를 *고른다*. 쿼리 실행과 도큐먼트 파싱은
 * `retrieve.ts`가 한다. 그래야 (a) 1홉 제한·상한·순환·고아 처리를 컨테이너 없이 단위
 * 테스트로 잠글 수 있고, (b) `retrieve.ts ↔ relation-expansion.ts` 순환 import가 생기지 않는다.
 * (`rrf.ts`가 같은 규약이다 — DB도 env도 모른다.)
 *
 * ## 순환 참조를 무엇이 막는가 (Acceptance 4)
 *
 * A가 B를 `recurrence_of`, B가 A를 `recurrence_of`로 가리키면 재귀 순회는 돈다.
 * 여기서 도는 일이 없는 이유는 **`$graphLookup`의 `maxDepth: 0`** 하나다:
 * 0은 "초기 조회만 수행"이라 `startWith`가 가리킨 문서까지만 가고 `connectFromField`를
 * 따라 한 걸음도 더 나아가지 않는다. 즉 방문 집합이 애초에 유한하고 재귀가 없다.
 * `$graphLookup`은 그 위에 자체 순환 방지까지 갖고 있지만 **우리가 기대는 것은 깊이 제한**이다 —
 * 깊이를 올리는 순간(단계 1·2로 갈 때) 그 두 번째 방어선이 필요해진다.
 * `RELATION_GRAPH_MAX_DEPTH`를 env로 열지 않은 이유가 이것이다: 이 값은 튜닝 파라미터가
 * 아니라 **specs/03 §2.5의 "1홉"이라는 문면**이고, 열어 두면 아무도 모르게 2홉이 될 수 있다.
 */
import type { ChunkSection, RelationType } from "@sentinel/contracts";

import type { PipelineStage, RelationProvenance } from "./types.js";

/**
 * specs/03 §2.5가 지목한 두 관계. `related`·`corrects`는 **일부러 제외한다** —
 * 전자는 "그냥 관련"이라 인과가 없고, 후자는 divergence 교정 링크라 `resolution`/
 * `prevention` 섹션 자체가 없다. 넓히려면 스펙을 먼저 고쳐야 한다(CLAUDE.md 최우선 원칙 1).
 */
export const EXPANDABLE_RELATION_TYPES: readonly RelationType[] = [
  "recurrence_of",
  "same_root_cause",
];

/**
 * 확장으로 끌어오는 섹션. **배열 순서가 곧 우선순위다** — 상한(+3)에 걸릴 때
 * `prevention`보다 `resolution`을 먼저 남긴다. "재발 사슬을 따라가 해결 절차를 얻는다"가
 * 이 확장의 목적이고(ADR-07 G2), 예방책은 그다음이다.
 */
export const EXPANDED_SECTIONS: readonly ChunkSection[] = ["resolution", "prevention"];

/**
 * specs/03 §2.5의 "**최대 +3청크**". env로 열지 않는다 —
 * `generate.ts`의 `MAX_REGENERATIONS`와 같은 판단이다: 스펙 문면이지 튜닝 값이 아니고,
 * 열어 두면 상한을 20으로 올려 NFR-03 예산을 조용히 태울 수 있다.
 * 이 숫자를 바꾸려면 specs/03을 먼저 고쳐야 한다.
 */
export const MAX_RELATION_CHUNKS = 3;

/**
 * `$graphLookup`의 재귀 깊이. **0 = 초기 조회만 = 1홉.** 위 모듈 주석 참조.
 * `1`로 두면 2홉이 되어 specs/03 §2.5를 위반한다.
 */
export const RELATION_GRAPH_MAX_DEPTH = 0;

/** `$graphLookup` 결과가 담기는 필드 이름. 파이프라인과 파서가 같은 이름을 봐야 한다. */
export const RELATION_TARGETS_FIELD = "relationTargets";

/**
 * 진입점 레코드의 1홉 관계 대상을 찾는 파이프라인.
 *
 * `startWith`가 **필터된 목록**인 것이 요점이다. `"$relations.targetRecordId"`를 그대로 쓰면
 * `related`·`corrects` 대상까지 조회한 뒤 나중에 버리게 되는데, 그건 스펙이 정한 두 종류만
 * 확장한다는 사실이 파이프라인이 아니라 후처리에만 존재한다는 뜻이다 — 후처리를 한 줄
 * 지우면 조용히 넓어진다.
 *
 * `relations` 자체도 같은 필터를 통과한 것만 남긴다. 그래야 돌아온 문서에서 "어느 진입점이
 * 어떤 관계로 이 대상을 가리켰나"를 복원할 때 확장 대상 밖 관계가 섞이지 않는다
 * (`$graphLookup`은 어느 엣지를 타고 왔는지 기록해 주지 않는다).
 */
export function buildRelationLookupPipeline(
  entryRecordIdsRaw: readonly unknown[],
  recordsCollection: string,
): PipelineStage[] {
  const expandable = {
    $filter: {
      input: { $ifNull: ["$relations", []] },
      as: "relation",
      cond: { $in: ["$$relation.type", [...EXPANDABLE_RELATION_TYPES]] },
    },
  };

  return [
    { $match: { _id: { $in: [...entryRecordIdsRaw] } } },
    { $project: { relations: expandable } },
    {
      $graphLookup: {
        from: recordsCollection,
        startWith: {
          $map: { input: "$relations", as: "relation", in: "$$relation.targetRecordId" },
        },
        connectFromField: "relations.targetRecordId",
        connectToField: "_id",
        as: RELATION_TARGETS_FIELD,
        maxDepth: RELATION_GRAPH_MAX_DEPTH,
      },
    },
    // 대상 레코드의 **존재 여부**만 필요하다. 본문을 끌어오면 확장이 조인 비용을 폭발시킨다.
    { $project: { relations: 1, [`${RELATION_TARGETS_FIELD}._id`]: 1 } },
  ];
}

/** 확장의 출발점(진입점)과 도착점(대상)을 잇는 엣지 1건. */
export interface RelationTarget {
  /** 이 관계를 선언한 진입점 레코드. */
  readonly fromRecordId: string;
  readonly type: RelationType;
  readonly targetRecordId: string;
  /** 드라이버가 준 원본 id. chunks 조회의 `$in`에 그대로 쓴다(`PathCandidate.recordIdRaw`와 같은 이유). */
  readonly targetRecordIdRaw: unknown;
}

/**
 * `$graphLookup` 결과에서 확장 대상 엣지를 뽑는다.
 *
 * ## 삭제된 대상은 조용히 뺀다 (T-011 F-11과 같은 처리)
 *
 * `relations[].targetRecordId`가 가리키는 레코드가 지워졌으면 `$graphLookup`의
 * `relationTargets`에 그 id가 **없다**. 그러면 여기서 걸러진다.
 * 이유는 고아 청크 때와 같다: 존재하지 않는 레코드의 청크는 조회해도 0건이고,
 * 설령 청크가 남아 있어도 title/summary를 만들 수 없어 인용할 수 없다.
 * **던지지 않는 이유**는 관계가 끊어진 것이 검색 실패는 아니기 때문이다 —
 * 진입점 자체의 hit은 여전히 유효하고, 확장은 어디까지나 보강이다.
 * (끊어진 링크를 되짚어야 하면 `get_record`가 `relations`를 그대로 내준다 — T-015.)
 *
 * ## 순서가 결정론이어야 하는 이유
 *
 * 상한이 +3이므로 **무엇이 잘리는지가 순서에 달려 있다.** 순서가 흔들리면 같은 질의가
 * 호출마다 다른 컨텍스트를 받고, eval의 on/off 비교가 잡음을 재게 된다.
 * 순서는 (1) 진입점의 융합 순위, (2) `EXPANDABLE_RELATION_TYPES` 순서, (3) 대상 id 사전순이다.
 */
export function parseRelationTargets(
  docs: readonly Record<string, unknown>[],
  entryRecordIdOrder: readonly string[],
  toId: (value: unknown) => string,
): RelationTarget[] {
  const rank = new Map(entryRecordIdOrder.map((id, index) => [id, index]));
  const targets: RelationTarget[] = [];
  const seen = new Set<string>();

  for (const doc of docs) {
    const fromRecordId = toId(doc["_id"]);
    const existing = new Map<string, unknown>();
    for (const target of asArray(doc[RELATION_TARGETS_FIELD])) {
      if (!isRecord(target)) continue;
      existing.set(toId(target["_id"]), target["_id"]);
    }

    for (const relation of asArray(doc["relations"])) {
      if (!isRecord(relation)) continue;
      const type = relation["type"];
      if (typeof type !== "string" || !EXPANDABLE_RELATION_TYPES.includes(type as RelationType)) {
        continue;
      }
      const targetRecordId = toId(relation["targetRecordId"]);
      // 삭제된 대상. 위 문단 참조 — 조용히 뺀다.
      if (!existing.has(targetRecordId)) continue;
      /*
       * 자기 자신을 가리키는 관계(A → A). 데이터 오류지만 실재할 수 있고, 그대로 두면
       * 진입점의 청크를 "확장으로 들어온 것"처럼 한 번 더 싣는다. 엣지 단계에서 끊는다.
       */
      if (targetRecordId === fromRecordId) continue;

      const key = `${fromRecordId} ${type} ${targetRecordId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      targets.push({
        fromRecordId,
        type: type as RelationType,
        targetRecordId,
        targetRecordIdRaw: existing.get(targetRecordId),
      });
    }
  }

  const unranked = entryRecordIdOrder.length;
  return targets.sort((a, b) => {
    const byEntry = (rank.get(a.fromRecordId) ?? unranked) - (rank.get(b.fromRecordId) ?? unranked);
    if (byEntry !== 0) return byEntry;
    const byType =
      EXPANDABLE_RELATION_TYPES.indexOf(a.type) - EXPANDABLE_RELATION_TYPES.indexOf(b.type);
    if (byType !== 0) return byType;
    return a.targetRecordId < b.targetRecordId ? -1 : a.targetRecordId > b.targetRecordId ? 1 : 0;
  });
}

/**
 * 확장 대상 레코드의 `resolution`/`prevention` 청크를 긁는 파이프라인.
 *
 * `embeddingVersion` 필터는 두 검색 경로와 **같은 이유**로 건다 — 세대가 섞이면 이미
 * 대체된 청크가 컨텍스트에 실린다. `$project`는 호출자가 주는 그 표를 그대로 쓴다
 * (`CANDIDATE_PROJECTION`을 여기서 다시 정의하면 두 벌이 갈라진다).
 * `score`를 `0`으로 투영하는 이유는 `RetrievedChunk.relation` 주석에 있다 —
 * 확장 청크는 융합에 참여하지 않았고, 파서가 요구하는 필드를 정직한 값으로 채운다.
 */
export function buildRelationChunkPipeline(
  targetRecordIdsRaw: readonly unknown[],
  embeddingVersion: number,
  projection: PipelineStage,
): PipelineStage[] {
  return [
    {
      $match: {
        recordId: { $in: [...targetRecordIdsRaw] },
        section: { $in: [...EXPANDED_SECTIONS] },
        embeddingVersion,
      },
    },
    { $project: { ...projection, score: { $literal: 0 } } },
  ];
}

/** 확장으로 채택된 청크 1건과 그것이 타고 온 관계. */
export interface ExpansionPick<Candidate> {
  readonly candidate: Candidate;
  readonly relation: RelationProvenance;
}

/** 선택에 필요한 최소 형상. 실제 후보(`PathCandidate`)는 이보다 많은 필드를 갖는다. */
export interface ExpandableCandidate {
  readonly chunkId: string;
  readonly recordId: string;
  readonly section: ChunkSection;
  readonly seq: number;
}

/**
 * 확장 청크를 **최대 `max`개** 고른다. specs/03 §2.5의 "최대 +3청크"가 이행되는 지점이다.
 *
 * 규칙:
 *  - `excludeChunkIds`(=이미 검색 결과에 있는 청크)는 건너뛴다. 같은 청크를 두 번 실으면
 *    예산만 쓰고 근거는 늘지 않는다.
 *  - 같은 청크가 두 진입점의 관계로 동시에 도달해도 **한 번만** 싣는다. 이때 출처는
 *    먼저 온 쪽(=상위 진입점)이다.
 *  - 대상 레코드 안에서는 `EXPANDED_SECTIONS` 순서 → `seq` 순서.
 *  - `max`에 도달하면 즉시 멈춘다. **여기가 유일한 상한 집행 지점이다.**
 */
export function selectExpansionChunks<Candidate extends ExpandableCandidate>(
  candidates: readonly Candidate[],
  targets: readonly RelationTarget[],
  excludeChunkIds: ReadonlySet<string>,
  max: number,
): ExpansionPick<Candidate>[] {
  const picks: ExpansionPick<Candidate>[] = [];
  if (max <= 0) return picks;

  const byRecord = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byRecord.get(candidate.recordId);
    if (bucket === undefined) byRecord.set(candidate.recordId, [candidate]);
    else bucket.push(candidate);
  }
  for (const bucket of byRecord.values()) {
    bucket.sort((a, b) => {
      const bySection =
        EXPANDED_SECTIONS.indexOf(a.section) - EXPANDED_SECTIONS.indexOf(b.section);
      return bySection !== 0 ? bySection : a.seq - b.seq;
    });
  }

  const taken = new Set(excludeChunkIds);
  for (const target of targets) {
    for (const candidate of byRecord.get(target.targetRecordId) ?? []) {
      if (picks.length >= max) return picks;
      if (taken.has(candidate.chunkId)) continue;
      taken.add(candidate.chunkId);
      picks.push({
        candidate,
        relation: { type: target.type, fromRecordId: target.fromRecordId },
      });
    }
  }
  return picks;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
