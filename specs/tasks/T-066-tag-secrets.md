# T-066: 시크릿으로 보이는 태그를 거부한다 (T-052 F-1, T-007 R-4)
refs: specs/tasks/T-052-outbound-masking.md (F-1), specs/tasks/T-007-records-api.md (R-4), specs/00-product.md FR-06
M: M1 | deps: T-051, T-052

## 배경

태그는 `{tags:1}` 인덱스와 `chunks.meta.tags` 필터의 정확 일치 키라 마스킹할 수 없다(마스킹하면 저장 태그와 질의 태그가
갈려 조회가 깨진다). 그래서 T-052까지도 평문으로 저장됐고 목록 응답(`RecordSummary.tags`)·MCP 출력으로 나갔다.
T-007 R-4가 "시크릿이 있으면 400 거부"를 제안했다.

## Scope
- `POST /v1/records`, `PATCH /v1/records/:id`: 태그마다 `applyMasking`으로 시크릿을 검출하면 기존 400 `VALIDATION_FAILED`로 거부.
  `details`에 `["tags", n]` 경로만 싣고 값은 싣지 않는다. 새 상태 코드·오류 코드는 없다.
- 통합 테스트 2건.

## Out of scope
- specs/04 문면 개정. 기존 입력 검증 400의 한 사례라 계약 표면(상태·코드)은 바뀌지 않는다. 문서화는 Findings F-1.

## Acceptance
1. `REQUIRE_DOCKER=1 pnpm vitest run --project integration packages/api/src/records.int.spec.ts` 그린.
2. 뮤테이션: 두 `assertNoSecretTags` 호출을 빼면 새 테스트 2건이 실패한다.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/api/src/records.ts`, `packages/api/src/records.int.spec.ts`, `specs/tasks/T-007-records-api.md`(R-4)

## Findings
- **F-1** specs/04의 `/v1/records` 400 설명에 "시크릿으로 보이는 태그"를 한 줄 더하는 것이 좋다(사람 승인 사항).

STATUS: GREEN
