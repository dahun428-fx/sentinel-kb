# T-022: feedback API + MCP give_feedback
refs: FR-07, specs/02 (eval_cases 규칙)
M: M4 | deps: T-007

## Scope
- POST `/v1/feedback` + MCP `give_feedback` 연결
- helped=true인 피드백을 `eval_cases` **후보**로 적재(approvedBy 미설정)
- 승인 CLI `pnpm eval:approve` — 사람이 검토 후 골든셋 승격

## Out of scope
- 자동 승격 (금지 사항)

## Acceptance
- [ ] 피드백 저장 후 후보 목록에 나타남
- [ ] 승인 없이는 eval 러너가 그 케이스를 사용하지 않음을 검증
- [ ] 같은 (recordId, query) 중복 피드백은 upsert
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, specs/04, packages/api/**, packages/mcp/**
