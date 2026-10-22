# T-065: 기존 검색 인덱스의 정의 drift를 잡는다 (P1 리뷰 C7)
refs: docs/plan/UPLIFT-PLAN.md §4-2 (C7), specs/02-data-model.md §인덱스, packages/core/src/db/search-indexes/*.json
M: M2 | deps: T-010

## 배경

`ensureSearchIndexes`는 이미 있는 인덱스에 대해 `vec_idx`의 `numDimensions`만 대조했다. `similarity`가 바뀌어도
(cosine → dotProduct) 통과했는데, 그러면 retriever의 원시 cosine 환산(`2s−1`, `retrieve.ts`)이 조용히 틀린 값을 낸다.
analyzer·filter 경로 변경도 같았다. 오래된 atlas-local 볼륨에 `db-init`을 다시 돌리는 P3·P4에서 생길 수 있다.

## Scope
- `assertDefinitionMatches`: 정의 파일의 모든 항목이 기존 `latestDefinition`에 같은 값으로 있는지 **부분집합** 비교.
  서버가 기본값을 덧붙여도 통과한다. 다르면 `SEARCH_INDEX_DEFINITION_DRIFT`로 멈추고 재생성하지 않는다.
- 단위 테스트 4건(similarity, filter 경로, analyzer, 기본값 덧붙임 통과). 기존 스텁 두 곳은 정의 파일 그대로의 정의를
  돌려주게 고쳤다(이전 스텁은 빈 정의였다) — 단언은 그대로다.

## Acceptance
1. `pnpm vitest run --project unit packages/core/src/db/search-indexes.spec.ts` 그린.
2. 실제 atlas-local에서 두 번째 `ensureSearchIndexes`가 drift 없이 `existing`으로 끝난다(`search-indexes.int.spec.ts`, `indexes.int.spec.ts`).
3. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/core/src/db/{search-indexes.ts,search-indexes.spec.ts,search-indexes.int.spec.ts}`, `packages/core/src/db/search-indexes/*.json`, `packages/core/src/retriever/retrieve.ts`(환산)

STATUS: GREEN
