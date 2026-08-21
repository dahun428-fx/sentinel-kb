# T-012: /v1/search 라우트
refs: specs/04-api.md
M: M2 | deps: T-011

## Scope
- POST `/v1/search` — contracts 스키마 검증, retriever 호출, `summary` 포함 응답
- 응답에 본문 미포함(NFR-03 기반), flags 노출
- 레이턴시 로깅(pino) — p95 측정 가능한 필드

## Out of scope
- 생성(answer)

## Acceptance
- [ ] 통합 테스트: 시드 기준 알려진 쿼리 3개가 기대 record를 Top-5에 포함
- [ ] 잘못된 limit(>20) → 400
- [ ] 응답 어디에도 record 본문 전체가 없음을 검증
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, packages/api/**, packages/core/src/retriever/**
