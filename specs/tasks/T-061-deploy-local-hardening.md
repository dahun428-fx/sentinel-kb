# T-061: 배포 .env의 `$` 값과 로컬 atlas-local 보안
refs: docs/plan/UPLIFT-PLAN.md §4-2 (S8 (Major), S9 (Minor), T-050 F-1·F-2)
M: M6 | deps: T-025,T-026

## 배경

2026-10-22 P1 AI 리뷰(UPLIFT §4-2) 지적. 근거 위치는 리뷰가 코드에서 확인했고, 주요 건은 재확인했다.

- S8: `infra/deploy/deploy.sh:135`가 `NAME=value`를 따옴표 없이 쓴다. Compose v2는 따옴표 없는 `.env` 값의 `$VAR`를 보간하므로
  `$`가 든 비밀번호가 조용히 바뀐다. 이전 스택을 내린 뒤 인증이 실패한다(미실측).
- S9: 로컬 atlas-local 안전 기동법이 문서에 없다. 흔히 쓰는 `docker run -p 27017:27017`은 인증 없는 DB를 사무실 네트워크에 연다.
  테스트 헬퍼도 `-P`(모든 인터페이스)와 `:latest`를 쓴다(`packages/core/src/testing/atlas-local.ts:30,92`).
- T-050 F-1: compose 밖 `pnpm dev`는 core-api·MCP를 0.0.0.0에 연다. F-2: 키 최소 길이가 없다.

## Scope
- `.env` 렌더를 작은따옴표 + 이스케이프로, 또는 `$` 포함 값 거부.
- runbook에 `127.0.0.1:27017` + `MONGODB_INITDB_ROOT_*` 기동법, 이미지 태그 고정.
- listen 기본값 127.0.0.1 + compose에서 `HOST=0.0.0.0`. 운영에서 32자 미만 키 거부.

## Acceptance
1. `$`가 든 값이 렌더 후 compose `config`에서 원문 그대로다.
2. runbook 기동법을 따르면 27017이 127.0.0.1에만 열린다.
3. `pnpm verify` 그린.

## Context budget
- 읽기: `infra/deploy/deploy.sh`, `tools/deploy-contract.spec.ts`, `docs/runbook.md`, `packages/core/src/testing/atlas-local.ts`, `packages/api/src/server.ts`, `packages/mcp/src/http.cli.ts`, `packages/core/src/auth/api-keys.ts`

## 처리 메모
- S9는 P3 전에 runbook만이라도 먼저. S8은 P9 전.

STATUS: TODO
