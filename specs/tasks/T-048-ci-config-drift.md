# T-048: CI deploy-config 더미 env 누락 수정 + nightly 스케줄 일시 중지
refs: specs/05-test-strategy.md, specs/06-deployment.md, docs/plan/UPLIFT-PLAN.md
M: M6 | deps: T-042, T-046

## 배경

2026-10-21 main push 후 GitHub Actions에서 두 가지가 확인됐다 (UPLIFT §9-2 F-1, F-4).

1. **`ci` → `deploy-config`가 실패한다.** T-042가 `docker-compose.yml:273`에
   `WEB_HTPASSWD_B64:?`를 필수로 넣었는데 `.github/workflows/ci.yml`의 더미 env(`/tmp/ci.env`)에는
   추가되지 않았다. `compose config`가 해소에 실패한다. `tools/compose-contract.int.spec.ts`는
   자기 fixture를 따로 들고 있어 이 누락을 보지 못했다. 두 목록이 같은 소스를 보지 않는다.
2. **`nightly-eval`이 매일 실패한다.** 저장소에 eval 시크릿이 없어 러너가 EX_CONFIG(78)로
   거절한다. 설계대로의 거절이지만 미배포 상태에서는 매일 실패 알림만 남는다.

## Scope
- `ci.yml` 더미 env에 `WEB_HTPASSWD_B64` 추가.
- `tools/workflow-contract.spec.ts`: compose base·prod의 `${VAR:?}` 목록을 **파일에서 계산해**
  더미 env가 전부 덮는지 단언. 손으로 맞춘 목록은 다시 어긋난다.
- `nightly-eval.yml`: `schedule` 트리거를 주석 처리. `workflow_dispatch`는 유지.
  자격증명이 없으면 건너뛰고 통과시키는 방식은 쓰지 않는다 (UPLIFT Q-3 (b), 가짜 그린).

## Out of scope
- eval 러너의 자격증명 처리, `specs/05` 개정. `specs/05:28` "eval은 nightly"는 목표 상태로 두고,
  이번 비활성화는 UPLIFT P4(실 자격증명 등록)까지의 임시 조치다 (Findings F-1).
- `infra`·`deploy` 워크플로의 의도된 실패 (AWS 미설정, UPLIFT F-2·F-3).

## Acceptance
1. `pnpm vitest run --project unit tools/workflow-contract.spec.ts` 그린.
2. 뮤테이션: `ci.yml`에서 `WEB_HTPASSWD_B64=` 줄을 빼면 새 단언이 `['WEB_HTPASSWD_B64']`로 실패한다.
3. `ci.yml`의 heredoc을 그대로 꺼내 `docker compose --env-file … config`(base, base+prod)가 종료 코드 0.
4. `grep -n "^  schedule:" .github/workflows/nightly-eval.yml` → 출력 없음, `workflow_dispatch:` 유지.
5. `pnpm verify` 그린.

## Context budget
- 읽기: `.github/workflows/{ci.yml,nightly-eval.yml}`, `tools/workflow-contract.spec.ts`,
  `docker-compose.yml`, `docker-compose.prod.yml`(`:?` grep), `tools/compose-contract.int.spec.ts`(fixture),
  `specs/05-test-strategy.md`(CI 절), `specs/tasks/T-046-ci-wiring.md`

## Findings
- **F-1** `specs/05:28` "E2E와 eval은 nightly"와 현재 워크플로가 다르다. 스펙을 바꾸지 않고 임시로
  어긋나 있음을 기록한다. P4에서 시크릿(`MONGODB_TEST_URI`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `EVAL_API_KEYS`)과 변수를 등록한 뒤 `schedule` 줄의 주석을 풀어야 한다. UPLIFT P4 완료 증거에 넣는다.

STATUS: GREEN
