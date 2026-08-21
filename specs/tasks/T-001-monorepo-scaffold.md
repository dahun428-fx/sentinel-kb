# T-001: 모노레포 스캐폴드 + verify 파이프라인
refs: specs/01-architecture.md
M: M0 | deps: -

## Scope
- pnpm workspaces: contracts / core / api / mcp / worker / web
- TypeScript strict, 공유 tsconfig.base.json, ESLint + Prettier
- Vitest 설정 (unit / integration 분리 프로젝트)
- 루트 스크립트: verify, test, test:integration, build, **dev(패키지 병렬 dev 서버 — compose 없이 동작해야 함, 감사 A-5)**
- `.github/workflows/ci.yml`: lint→typecheck→unit→integration→build

## Out of scope
- 실제 도메인 로직, Docker, 배포

## Acceptance
- [ ] `pnpm verify`가 빈 프로젝트에서 그린
- [ ] 각 패키지에 `src/index.ts`와 통과하는 스모크 테스트 1개
- [ ] 의존 방향 위반 시 실패하는 eslint 규칙(import/no-restricted-paths) 동작 확인 테스트
- [ ] CI 워크플로가 PR에서 실행되어 성공

## Context budget
- 읽기: specs/01-architecture.md, package.json, pnpm-workspace.yaml
