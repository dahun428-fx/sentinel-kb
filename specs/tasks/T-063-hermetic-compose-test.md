# T-063: compose 계약 테스트가 실행 환경의 env에 흔들리지 않게 한다
refs: specs/05-test-strategy.md, .github/workflows/deploy.yml
M: M6 | deps: T-026, T-027

## 배경

2026-10-22 main push 후 `deploy` 워크플로의 `pnpm verify` 잡이 실패했다(직전 push에서도 같은 실패).
`tools/compose-contract.int.spec.ts` "모든 앱 이미지가 ECR에서 온다"가 `:test-tag`를 기대하는데 다른 태그가 나왔다.
compose는 `${VAR}`를 셸 환경에서 먼저 찾고 `--env-file`은 그다음인데, `deploy.yml:39`가 워크플로 전체에
`IMAGE_TAG: ${{ inputs.image_tag || github.sha }}`를 건다. `ci` 워크플로에서는 그 변수가 없어 통과했다.
즉 **배포 게이트가 코드와 무관하게 항상 빨갛다** — UPLIFT P9 전에 막힌다.

## Scope
- `runComposeConfig`에 docker 실행에 필요한 변수(PATH, HOME, USER, TMPDIR, LANG, DOCKER_*, XDG_*)만 넘긴다.
- 셸에 `IMAGE_TAG`가 있어도 fixture 값으로 해소되는지 보는 단언 1건.

## Out of scope
- `deploy.yml`의 env 범위 조정. 테스트가 환경에 독립적이어야 하는 것이 먼저다.

## Acceptance
1. `IMAGE_TAG=from-shell REQUIRE_DOCKER=1 pnpm vitest run --project integration tools/compose-contract.int.spec.ts` 그린.
2. 뮤테이션: `env: hermeticEnv()`를 빼면 새 단언이 실패한다.
3. `pnpm verify` 그린, push 후 `deploy` 워크플로의 `pnpm verify` 잡 그린.

## Context budget
- 읽기: `tools/compose-contract.int.spec.ts`, `.github/workflows/deploy.yml`(env), `tools/deploy-rollback.int.spec.ts`(env 처리 비교)

STATUS: GREEN
