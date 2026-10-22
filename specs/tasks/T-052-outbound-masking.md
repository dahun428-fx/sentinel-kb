# T-052: 외부로 나가거나 저장되는 검색어·피드백·관계 메모의 시크릿 마스킹 (P1 보안 리뷰 S2·S3)
refs: specs/00-product.md FR-06, specs/tasks/T-007-records-api.md (R-2, R-4), docs/plan/UPLIFT-PLAN.md §5
M: M4 | deps: T-051

## 배경

P1 보안 리뷰 S2 (Critical), S3 (Major).
- **검색어가 마스킹 없이 외부로 나갔다.** `/v1/search`·`/v1/answer`의 query는 임베딩을 위해 Voyage로,
  생성 문맥으로 Anthropic으로 간다. T-007 R-2는 "쿼리는 저장되지 않는다"를 근거로 마스킹하지 않기로
  했는데, 기준은 저장이 아니라 외부 전송이어야 했다. `suggest_resolution`은 에이전트에게 에러 원문을
  "그대로 붙여 넣으라"고 안내하므로 접속 문자열·토큰이 섞이는 것이 보통이다.
- **피드백의 query·note가 평문으로 저장됐다.** `helped:true`면 query가 프로젝트 구분 없는
  `eval_cases` 후보로 복사되고, eval 때 다시 외부 API로 나간다.
- **`relations[].note`가 평문으로 저장됐다.** T-007 R-4가 미결로 남긴 항목이다. note는 자유 텍스트라
  마스킹해도 깨지는 조회가 없다.

## Scope
- `sanitize-record.ts`: `maskOutboundText()` — `applyMasking()`만 쓴다. 길이 상한(413)은 걸지 않는다.
- `search.ts`·`answer.ts`: retriever와 `generateAnswer`에 마스킹한 query를 넘긴다. R-2 주석 갱신.
- `feedback.ts`: 저장 전 query·note 마스킹. 문서 `_id`도 마스킹한 query로 만든다.
- `records.ts`: PATCH의 `relations[].note` 마스킹, 마스킹이 일어나면 `secret-masked` 플래그.
- 테스트 4건(검색 unit, 답변·피드백·레코드 integration).

## Out of scope
- `tags` 시크릿 처리. 정확 일치 키라 마스킹하면 조회가 깨진다. 거부(400)할지는 R-4의 남은 쟁점이고
  스펙 개정(인간 승인)이 필요하다. Findings F-1.
- 로그. 라우트는 이미 query 길이만 남긴다.

## Acceptance
1. `pnpm vitest run --project unit packages/api` 그린.
2. `REQUIRE_DOCKER=1 pnpm vitest run --project integration packages/api/src/{answer,feedback,records,search}.int.spec.ts` 그린.
3. 뮤테이션: 네 곳의 `maskOutboundText` 호출을 각각 원문으로 되돌리면 새 테스트 4건이 실패한다.
4. `pnpm verify` 그린.

## Context budget
- 읽기: `packages/api/src/{search.ts,answer.ts,feedback.ts,records.ts,sanitize-record.ts}`와 각 spec,
  `packages/contracts/src/common.ts`(Relation), `specs/tasks/T-007-records-api.md`(R-2, R-4)

## Findings
- **F-1** `tags`의 시크릿은 여전히 평문이다(`RecordSummary.tags`로 목록에도 노출). T-007 R-4의
  "시크릿이 있으면 400 거부" 안을 스펙에 넣을지 사람이 정해야 한다.
- **F-2** 피드백이 존재하지 않는 recordId도 204로 받는다(P1 리뷰 A5-a). 별도 태스크.

STATUS: GREEN
