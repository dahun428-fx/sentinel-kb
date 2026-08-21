# T-017: 클라이언트 연결 문서 + .mcp.json 배포
refs: specs/07-mcp.md (도그푸딩)
M: M3 | deps: T-015

## Scope
- `docs/connect.md`: .mcp.json 예시, 키 발급 절차, 프로젝트 CLAUDE.md에 넣을 프로토콜 문구
- 실제 프로젝트 2곳에 연결 적용 (자기 자신 포함)
- 연결 확인용 `pnpm mcp:ping` 스크립트

## Out of scope
- UI

## Acceptance
- [ ] 다른 프로젝트의 Claude Code 세션에서 search_knowledge 호출 성공 스크린샷/로그가 docs에 첨부
- [ ] `pnpm mcp:ping`이 원격 서버 도구 목록 5개를 출력
- [ ] 이 레포 CLAUDE.md에 도그푸딩 프로토콜이 반영됨
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07, docs/**, CLAUDE.md
