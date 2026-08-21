# T-009: 시드 데이터 50건 + db:seed
refs: FR-10, specs/05
M: M1 | deps: T-007, T-008

## Scope
- `packages/core/seed/`: incident 40건(실사례 20 + 공개 포스트모템 요약 20), divergence 10건
- **자기 시드 편입**: `seed/self/SELF-01~05.json` (이 프로젝트 설계 과정의 실사건 — PORTFOLIO-WEAVE 채널 2)을 시드에 포함하고, 이후 감사·개발 중 사건을 여기에 누적
- 공개 포스트모템은 **원문 복제 금지** — 자기 문장으로 요약하고 출처 URL을 `tags`/`prevention`에 표기
- divergence 시드는 실제 겪은 이격 위주(환각 API, 버전 가정 오류, 스펙 드리프트 등)
- `pnpm db:seed` (idempotent, `--reset` 옵션)

## Out of scope
- 골든셋 (T-013)

## Acceptance
- [ ] seed 2회 실행해도 레코드 수 동일
- [ ] 50건 전부 published + chunks 생성 완료(워커 대기 후 검증)
- [ ] divergence 10건 모두 `context.model`과 `correction` 채워짐
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/02, packages/core/seed/**
