# T-015: MCP 도구 5종 구현
refs: specs/07-mcp.md
M: M3 | deps: T-014

## Scope
- search_knowledge / get_record / record_knowledge / give_feedback 구현
- suggest_resolution은 이 태스크에서 **검색 기반 스텁**(생성은 T-019에서 연결)
- get_record 응답에 `<retrieved-record>` data 래핑 + 지시 무시 문구 (NFR-05)
- record_knowledge 응답에 sanitizeFlags 경고 노출
- 각 도구 description은 specs/07 규칙대로 "무엇 + 언제 + 경계" 서술

## Out of scope
- RAG 생성, tool-selection eval

## Acceptance
- [ ] 도구 5개 정확히 등록됨(6개 이상이면 실패하는 테스트)
- [ ] search_knowledge 응답 토큰 추정치 <= 800 (테스트에서 tokenizer 근사 검증, NFR-03)
- [ ] get_record 응답에 래핑 태그와 지시 무시 문구 존재
- [ ] record_knowledge로 저장 시 project가 키에서 주입됨
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/07, packages/mcp/**, packages/contracts/src/**
