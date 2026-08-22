# T-036: `/v1/openapi.json` 서빙 + 스펙-코드 드리프트 가드
refs: specs/04-api.md
M: M2 | deps: T-012

## 배경

`specs/04:29`가 명시한다: "`packages/contracts`에서 zod-to-openapi로 생성, **`/v1/openapi.json` 서빙**.
수기 작성 금지." 그런데 **이 라우트를 만드는 태스크가 없었다**(T-007 R-7이 발견).
`packages/contracts/src/openapi.ts`에는 오퍼레이션이 이미 등록돼 있고 테스트도 있지만
서빙하는 곳이 없어, **문서가 약속한 엔드포인트가 존재하지 않는 상태**다.

이건 "스펙 없는 신규 API 추가 금지"의 **반대 사례**다 — 스펙은 있는데 구현이 없다.
방치하면 등록된 오퍼레이션과 실제 라우트가 갈라지는 것을 아무도 눈치채지 못한다.

## Scope
- `GET /v1/openapi.json` — `packages/contracts`가 생성한 문서를 그대로 서빙. **수기 작성 금지.**
- 인증 정책 결정: 이 엔드포인트가 Bearer를 요구하는가? (근거를 남길 것)
- **드리프트 가드**: 등록된 오퍼레이션 목록과 Fastify가 실제로 가진 라우트 목록을 대조하는 테스트.
  둘이 갈라지면 실패해야 한다 — 그게 이 태스크의 진짜 산출물이다.

## Out of scope
- Swagger UI 등 렌더링 (필요하면 별도 태스크)
- 새 오퍼레이션 추가 (그건 각 라우트 태스크의 몫)

## Acceptance
- [ ] `GET /v1/openapi.json`이 200과 유효한 OpenAPI 문서를 돌려준다
- [ ] 응답이 `packages/contracts`의 생성 결과와 **동일**함을 단언(수기 사본이 아님을 보장)
- [ ] **드리프트 가드**: openapi에 등록됐는데 라우트가 없는 오퍼레이션, 또는 라우트가 있는데
      등록되지 않은 경로가 있으면 테스트가 실패한다. 일부러 어긋나게 만들어 실패를 확인할 것
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/04, packages/api/**, packages/contracts/src/openapi.ts

## Findings (인계)

- **T-007 R-2: 413 `SANITIZE_INPUT_TOO_LARGE`가 openapi에 미등록이다.**
  길이 상한 초과 시 나가는 응답인데 문서에 없다. 이 태스크의 드리프트 가드는 **경로** 대조이지
  상태코드 대조가 아니므로 이건 별개로 잡아야 한다 — 가드를 상태코드까지 넓힐지 판단하라.
- `.github/workflows/ci.yml`의 `spec-drift` 잡(`scripts/spec-drift-check.sh`)이 이미 있다.
  **실패해도 머지를 막지 않고 경고만 낸다**(의도된 설계). 이 태스크의 가드는 그것과 달리
  `pnpm verify` 경로에 들어가 **머지를 막아야** 하는지 판단하고 근거를 남겨라.
