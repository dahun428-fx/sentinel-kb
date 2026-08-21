---
description: 최근 divergence 기록을 수확해 하네스 개선 태스크 초안을 만든다 (주 1회)
---

1. `search_knowledge(type:"divergence", limit:20)`로 최근 이격 기록 조회
2. `context.model` / `context.tool` / 증상 패턴으로 클러스터링
3. 2건 이상 반복된 패턴마다 교정 수단을 판단:
   - CLAUDE.md 규칙 추가 / 스킬 신설·수정 / 스펙 문구 보강 / 태스크 포맷 개선
4. 각각을 `specs/tasks/T-xxx-*.md` **초안**으로 생성 (Scope/Acceptance/Context budget 포함)
5. 요약 보고: 패턴 / 빈도 / 제안 / 초안 경로

**적용은 하지 않는다.** 사람이 초안을 승인해야 태스크가 된다.
