# T-003: Mongo 연결·인덱스 부트스트랩
refs: specs/02-data-model.md
M: M1 | deps: T-002

## Scope
- `core/src/db/client.ts`: 싱글턴 커넥션, graceful shutdown
- `core/src/db/indexes.ts`: records/jobs/feedbacks 일반 인덱스 생성(멱등)
- `pnpm db:indexes` 스크립트
- `/health`에 mongo 연결 상태 반영할 수 있는 `ping()` export

## Out of scope
- Atlas Search/Vector 인덱스 (T-010)

## Acceptance
- [ ] 통합 테스트: 인덱스 생성 2회 실행해도 에러 없음(멱등)
- [ ] 연결 실패 시 명확한 에러 코드로 종료하는 테스트
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, packages/core/src/db/**
