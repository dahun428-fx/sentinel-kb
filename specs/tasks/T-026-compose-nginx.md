# T-026: Docker Compose + nginx (SSE/MCP 버퍼링)
refs: specs/06-deployment.md
M: M6 | deps: T-019

## Scope
- 서비스별 멀티스테이지 Dockerfile (api/mcp/worker/web)
- `docker-compose.yml` + nginx conf: `/mcp`, `/v1`, `/` 라우팅
- **`proxy_buffering off`, read timeout 300s** — SSE·MCP 스트리밍 필수
- certbot 컨테이너 + 갱신 cron
- 헬스체크·재시작 정책·로그 드라이버
- 간단 부하 스크립트(autocannon): /v1/search p95 측정, 결과를 eval/reports/에 기록 (NFR-01, 감사 B-4)

## Out of scope
- CI 연동(T-027)

## Acceptance
- [ ] 로컬 `pnpm dev`(compose)로 전 서비스 기동 후 `/health` 200
- [ ] SSE 스트리밍이 nginx 경유로 청크 단위 도달함을 검증하는 통합 테스트
- [ ] MCP 클라이언트가 nginx 경유로 도구 목록 조회 성공
- [ ] 부하 스크립트가 p95 수치를 리포트로 남김
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/06, docker-compose.yml, infra/nginx/**
