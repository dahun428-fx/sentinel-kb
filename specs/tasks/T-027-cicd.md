# T-027: CI/CD 배포 파이프라인 (ECR + SSM)
refs: specs/06-deployment.md
M: M6 | deps: T-025, T-026

## Scope
- GH Actions: main 머지 시 verify → 이미지 빌드 → ECR push(태그: sha) → SSM RunCommand로 compose pull/up
- OIDC로 AWS 인증(장기 키 금지)
- 배포 후 `/health`와 MCP 도구 목록 스모크 체크, 실패 시 직전 태그로 롤백
- 배포 런북 `docs/runbook.md`

## Out of scope
- 블루/그린

## Acceptance
- [ ] 실제 배포 1회 성공 + 스모크 통과
- [ ] 의도적 실패 이미지로 롤백 동작 검증
- [ ] 워크플로에 정적 AWS 키가 없음(OIDC 사용) 검증
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/06, .github/workflows/**, docs/runbook.md
