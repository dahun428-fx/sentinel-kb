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

## Findings
스코프 밖이라 T-001에서 고치지 않았다. 담당 태스크에서 처리한다.

- **F-1 형제 패키지 간 import가 lint에 안 걸린다.** eslint zone의 target이 `contracts`·`core`뿐이라
  `mcp → api` 같은 최상위 형제 import는 통과한다. specs/01-architecture.md는 mcp가 core-api를
  HTTP로 소비한다고 못박았으므로 패키지 import는 설계 위반이다. **T-014 이전에 zone 추가.**
- **F-2 경계 픽스처가 상대 경로 형태만 커버한다.** 실제 코드가 쓰는 `@sentinel/*` 형태는
  워크스페이스 의존 그래프와 tsc가 막지만 픽스처로 고정돼 있지 않다. 패키지명 형태 픽스처 1개 추가 권고.
- **F-3 `pnpm dev`가 즉시 종료된다.** 6패키지 모두 placeholder라 상주 프로세스가 없다.
  감사 A-5의 "compose 없이 동작"은 충족하나, 실제 dev 서버는 T-007/T-008/T-014/T-023에서 교체 필요.
- **F-4 `build`와 `typecheck`가 둘 다 `tsc -b`로 동일하다.** composite 프로젝트가 `--noEmit`을
  허용하지 않아서다. 실제 번들 단계(tsup 등) 도입 시 분리.
- **F-5 패키지 `exports`가 소스(`./src/index.ts`)를 가리킨다.** vitest·tsc에는 맞지만 Node 런타임
  직접 import는 불가. 서버 기동 태스크(T-007/T-008/T-014)에서 dist 지향 exports 또는 tsx 실행 결정 필요.
- **F-6 `packages/core/seed/`·`eval/`·`scripts/`가 `tsc -b` 프로젝트 그래프 밖이다.**
  지금은 JSON뿐이라 무해하나 seed에 .ts가 생기면 타입체크 사각지대가 된다.
- **F-7 Acceptance 4는 로컬 재현으로만 판정했다.** 클린 `--frozen-lockfile` 설치부터 build까지
  ci.yml 전 스텝 exit 0 확인. 실제 GitHub Actions 실행은 PR 생성 후 재확인 필요.
