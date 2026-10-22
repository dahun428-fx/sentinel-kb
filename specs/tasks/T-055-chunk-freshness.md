# T-055: 제목·상태 변경이 청크에 반영되지 않는다
refs: docs/plan/UPLIFT-PLAN.md §4-2 (C4 (Major))
M: M2 | deps: T-007,T-008

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

재임베딩은 본문 섹션 변경이나 draft→published 전환에만 걸린다(`packages/api/src/records.ts:436-441`).
- 제목만 바꾼 PATCH는 모든 청크 앞머리(`[title] (section) `, `chunk-record.ts:69,86,95`)에 옛 제목을 남긴다. 그 텍스트가
  임베딩되고 BM25가 찾는 필드다.
- 태그·severity 변경이 `chunks.meta`에 반영되지 않는다.
- published→draft로 되돌려도 청크가 남아 검색된다. retriever에 상태 필터가 없다(`retrieve.ts:239-300`).

## Scope
- `title`(meta를 유지한다면 `tags`·`severity`) 변경 시 재임베딩 잡.
- published→draft 전환 시 그 레코드의 청크 삭제(또는 `meta.status` + 필터).

## Acceptance
1. 제목 PATCH 후 워커가 돌면 청크 텍스트 앞머리가 새 제목이다.
2. draft로 되돌린 레코드가 `/v1/search`에 나오지 않는다.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/api/src/records.ts`(PATCH), `packages/core/src/chunker/chunk-record.ts`, `packages/worker/src/ingest.ts`, `packages/core/src/retriever/retrieve.ts`, `specs/04-api.md`(PATCH)

## 처리 메모
- **임시 조치:** P5에서 제목을 고친 레코드는 본문 섹션을 한 글자라도 함께 고쳐 재임베딩을 일으킨다.

STATUS: TODO
