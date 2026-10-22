# T-064: nginx가 다시 만든 컨테이너의 새 IP를 따라가게 한다
refs: specs/06-deployment.md, nginx/conf.d/00-upstreams.conf, specs/tasks/T-053-embedding-generation.md (F-1)
M: M6 | deps: T-026

## 배경

T-053 실동작 확인 중 core-api 컨테이너만 다시 만들자 nginx가 502를 냈다. `nginx/conf.d/00-upstreams.conf`의
`upstream { server core-api:3001; }`는 nginx 기동 시 한 번 해석되므로, 새 컨테이너(새 IP)를 따라가지 못한다
(실측: nginx는 172.21.0.3, core-api는 172.21.0.2). 운영 배포는 nginx도 같은 태그로 다시 만들어 드러나지 않지만,
로컬 개발과 컨테이너 단독 재생성(`up -d core-api`)에서 재현된다.

## Scope
- nginx 1.27.3+의 `upstream` `zone` + `server … resolve`와 `resolver 127.0.0.11 valid=10s`로 Docker DNS를 주기적으로 다시 읽게 한다.
- `tools/nginx-contract.spec.ts`가 업스트림 정의를 대조하는 부분과 `nginx-streaming.int.spec.ts`의 더미 업스트림 치환이 깨지지 않는지 확인.

## Acceptance
1. 로컬 스택에서 `docker compose up -d --force-recreate core-api` 후 nginx 재시작 없이 `/v1/search`가 200.
2. `pnpm verify` 그린, CI `deploy-config`의 `nginx -t` 그린.

## Context budget
- 읽기: `nginx/conf.d/00-upstreams.conf`, `nginx/snippets/*.conf`, `docker/Dockerfile.nginx`, `tools/nginx-contract.spec.ts`, `tools/nginx-streaming.int.spec.ts`, `.github/workflows/ci.yml`(nginx 단계)

STATUS: TODO
