# T-030: 팩트 추출기 (결정론)
refs: specs/08-publishing.md §3, §5.1
M: M7 | deps: T-029

## Scope
- core/src/facts/: 소스 레코드 → facts 객체 + ChartSpec[]
- 통계(태그·심각도·프로젝트 분포), 타임라인 병합, 재발 지표, divergence 집계
- 인용 후보 추출 (sanitizeFlags 레코드 제외)
- LLM 호출 없음 — 전부 결정론적 계산

## Out of scope
- 서사 생성

## Acceptance
- [ ] 동일 입력 → 동일 출력 (결정론 테스트)
- [ ] 고정 시드 fixture에 대한 스냅샷 테스트 (통계·차트 데이터)
- [ ] 플래그 레코드의 원문이 인용 후보에 없음
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/08 §3·§5.1, packages/core/src/facts/**
