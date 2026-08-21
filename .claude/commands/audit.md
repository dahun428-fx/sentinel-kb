---
description: 마일스톤 감사 실행. 사용법 /audit [M0..M7|all]
---

1. auditor 에이전트로 감사 절차 수행 (기계 대조 → 척도 검사 → 주장-검증 대조 → 리스크 커버리지)
2. 보고서를 docs/audit/AUDIT-{date}.md로 저장
3. Critical/Major 적발은 수정 태스크 초안을 specs/tasks/에 생성 (적용은 사람 승인)
4. divergence 성격 적발은 seed/self/ 후보 JSON 초안 생성
5. 요약표를 출력하고 종료 — 감사자는 직접 수정하지 않는다
