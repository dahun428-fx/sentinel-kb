# T-024: 도그푸딩 연결 + /harvest 커맨드
refs: CLAUDE.md 도그푸딩 프로토콜, specs/07
M: M5 | deps: T-017

## Scope
- `.claude/commands/harvest.md`: 최근 divergence 레코드를 조회해 패턴을 뽑고,
  CLAUDE.md·스킬 수정 **태스크 스펙 초안**을 `specs/tasks/`에 생성
- 주 1회 실행 루틴 문서화
- 도그푸딩 계측: 주별 기록 건수·검색 적중 건수를 `eval/reports/dogfood-{week}.json`으로 집계

## Out of scope
- 자동 CLAUDE.md 수정 (초안 생성까지만, 적용은 사람 승인)

## Acceptance
- [ ] /harvest 실행 시 divergence 5건 이상 입력에서 태스크 초안 1개 이상 생성
- [ ] 생성된 초안이 태스크 스펙 포맷(Scope/Acceptance/Context budget) 준수
- [ ] 집계 스크립트가 주간 리포트 JSON 출력
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: CLAUDE.md, .claude/commands/**, specs/tasks/README.md
