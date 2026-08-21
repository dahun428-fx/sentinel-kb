# T-007: records CRUD API
refs: specs/04-api.md, FR-01
M: M1 | deps: T-003, T-004

## Scope
- Fastify 앱 + Bearer 인증 훅(키→project 클레임)
- POST/GET/PATCH `/v1/records`, GET 목록(cursor 페이지네이션)
- 저장 시 sanitizer 통과, `project`는 **키에서 주입**(바디 값 무시)
- published 전환 시 `jobs`에 embed job 삽입
- `summary` 자동 생성(첫 2문장)

## Out of scope
- 검색, 생성, 워커

## Acceptance
- [ ] 통합 테스트: 생성→조회→수정→목록 플로우
- [ ] 다른 project 키로 쓰기 시도 시 project가 강제 치환됨을 검증
- [ ] 인증 없음/잘못된 키 → 401, 스키마 위반 → 400 + 에러 코드
- [ ] 시크릿 포함 본문 저장 시 sanitizeFlags 기록 + 응답에 경고 포함
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, specs/02, packages/api/**, packages/core/src/sanitizer/**
