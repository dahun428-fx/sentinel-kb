# T-002: contracts — Zod 스키마 단일 소스
refs: specs/02-data-model.md, specs/04-api.md
M: M1 | deps: T-001

## Scope
- `RecordSchema`(discriminated union: incident | divergence), `ChunkSchema`, `FeedbackSchema`, `EvalCaseSchema`
- 요청/응답 스키마: CreateRecord, PatchRecord, SearchRequest/Response, AnswerRequest/Response, FeedbackRequest
- `z.infer` 타입 export, zod-to-openapi 등록
- 공통 에러 스키마 `{error:{code,message,details?}}`

## Out of scope
- 서버 구현, DB 접근

## Acceptance
- [ ] incident에 divergence 전용 필드를 넣으면 파싱 실패하는 테스트
- [ ] divergence에서 expected/actual 누락 시 실패하는 테스트
- [ ] `pnpm --filter contracts openapi` 가 유효한 OpenAPI 3.1 JSON 출력
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, specs/04, packages/contracts/**
