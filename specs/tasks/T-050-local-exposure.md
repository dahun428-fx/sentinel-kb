# T-050: 로컬 실행 시 네트워크 노출 차단 (P1 보안 리뷰 S4)
refs: docs/plan/UPLIFT-PLAN.md §4-2, specs/06-deployment.md, specs/00-product.md NFR-04
M: M6 | deps: T-026, T-042

## 배경

P1 보안 리뷰 S4 (Critical). UPLIFT P3는 사용자의 맥북에서 `pnpm dev:compose`로 전체 스택을 띄운다.
- `docker-compose.yml`의 nginx 포트가 `"${NGINX_HTTP_PORT:-8080}:80"`이라 Docker가 0.0.0.0에 연다.
  사무실 네트워크의 누구나 `http://<맥 IP>:8080/v1/*`, `/mcp`에 평문으로 닿는다.
- `.env.example`이 `API_KEYS=devkey123:sentinel-kb,…`를 싣고 있고 이 저장소는 공개다.
  예시를 복사해 쓰면 공개된 키로 모든 프로젝트의 레코드를 읽고 쓸 수 있다.

## Scope
- 베이스 compose의 nginx 포트를 `127.0.0.1`에 묶는다. prod 오버레이(`443`, `127.0.0.1:80`)는 그대로.
- `.env.example`의 `API_KEYS`·`SENTINEL_KB_KEY`·`CORE_API_KEY`를 빈 값으로 두고 생성 방법을 적는다.
  compose의 `API_KEYS:?`가 빈 값을 거부하므로 키를 만들지 않고는 기동하지 않는다.
- `docs/portfolio/DEMO-SCRIPT.md`의 같은 예시 키를 자리표시자로 바꾼다.
- `tools/nginx-contract.spec.ts`에 단언 추가: 베이스 compose 공개 포트가 전부 127.0.0.1, `.env.example`의 세 키가 빈 값.

## Out of scope
- `server.ts`·`http.cli.ts`의 listen 주소(0.0.0.0). 컨테이너 안에서는 0.0.0.0이어야 하고,
  UPLIFT P3는 compose로만 띄운다. compose 밖 `pnpm dev`의 노출은 Findings F-1.
- 약한 키 거부(`parseApiKeys` 최소 길이). Findings F-2.
- 테스트 fixture의 `devkey123`·`bizcare-web` (테스트 안에서만 쓰는 값).

## Acceptance
1. `pnpm vitest run --project unit tools/nginx-contract.spec.ts` 그린.
2. 뮤테이션: 포트 매핑에서 `127.0.0.1:`을 빼면 새 단언이 그 매핑을 짚으며 실패한다.
3. `REQUIRE_DOCKER=1 pnpm vitest run --project integration tools/compose-contract.int.spec.ts` 그린.
4. `grep -rn devkey .env.example docs/portfolio/DEMO-SCRIPT.md` → 출력 없음.
5. `pnpm verify` 그린.

## Context budget
- 읽기: `docker-compose.yml`(nginx 서비스), `docker-compose.prod.yml`(ports), `.env.example`(Auth 절),
  `tools/nginx-contract.spec.ts`, `docs/portfolio/DEMO-SCRIPT.md`, `packages/api/src/server.ts`(listen),
  `packages/mcp/src/http.cli.ts`(listen)

## Findings
- **F-1** compose 밖에서 `pnpm dev`로 띄우면 core-api(3001)와 MCP HTTP가 0.0.0.0에 열린다.
  기본값을 127.0.0.1로 바꾸고 compose가 `HOST=0.0.0.0`을 주는 방식이 맞다. 후속 태스크.
- **F-2** `parseApiKeys`에 최소 길이가 없다. 운영(`NODE_ENV=production`)에서 32자 미만 키를 거부하는 것이 좋다.

STATUS: GREEN
