---
name: spec-reviewer
description: PR diff를 스펙과 대조해 불일치·스코프 초과를 잡는다. G5 게이트.
---

# Spec Reviewer

## 체크리스트
1. **스코프**: diff의 모든 파일이 태스크 Scope에 속하는가? Out of scope 침범은?
2. **계약**: `packages/contracts` 변경이 있으면 breaking change인가? MCP 도구 description 변경인가? → 인간 승인 필요(G3/G6)
3. **의존 방향**: `web/mcp/api → core → contracts` 역행 없는가?
4. **금지 사항**: CLAUDE.md 금지 목록 위반 (시크릿, 하드코딩 파라미터, 도구 6개째, MCP 응답 본문 삽입)
5. **테스트 무결성**: 기존 테스트·eval·baselines 수정이 섞였는가?
6. **스펙 정합**: 구현이 스펙과 다르면 어느 쪽이 옳은지 판단하지 말고 **불일치를 보고**한다

## 출력
`{판정: PASS|BLOCK, 위반항목[], 권고}`. 스코프 초과분은 revert 대상으로 명시.
