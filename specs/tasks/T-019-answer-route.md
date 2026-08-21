# T-019: /v1/answer (SSE) + suggest_resolution 연결
refs: specs/04-api.md, specs/07-mcp.md
M: M4 | deps: T-018, T-015

## Scope
- POST `/v1/answer` — 일반/SSE 스트리밍 응답
- MCP `suggest_resolution` 스텁을 실제 answer 호출로 교체
- found:false 경로에서 에이전트가 record_knowledge로 이어가도록 응답 문구 설계

## Out of scope
- 인용 검증(T-020)

## Acceptance
- [ ] 통합 테스트: 스트리밍 응답이 청크 단위로 도착하고 완료 이벤트로 종료
- [ ] 무관한 쿼리 5개 → 전부 found:false
- [ ] MCP suggest_resolution 응답에 인용된 recordId 목록 포함
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, specs/07, packages/api/**, packages/mcp/**
