# T-014: MCP 서버 스켈레톤 + Bearer 인증
refs: specs/07-mcp.md
M: M3 | deps: T-012

## Scope
- `packages/mcp`: MCP SDK 서버, Streamable HTTP `/mcp` + stdio 어댑터(로컬)
- Bearer 인증 미들웨어 → project 클레임을 요청 컨텍스트에 주입
- core-api HTTP 클라이언트(타임아웃·재시도)
- 도구 0개 상태로 initialize/tools list 응답

## Out of scope
- 도구 구현 (T-015)

## Acceptance
- [ ] MCP SDK 클라이언트로 initialize 성공하는 통합 테스트
- [ ] 인증 헤더 없음 → 401
- [ ] stdio 모드에서도 동일 서버 인스턴스가 기동
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07, packages/mcp/**
