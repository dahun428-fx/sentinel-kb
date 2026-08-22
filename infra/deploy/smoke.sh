#!/usr/bin/env bash
# ===========================================================================
# 배포 스모크 (T-027 Scope: "`/health`와 MCP 도구 목록 스모크 체크").
#
# 호스트에서 돈다. 두 가지를 본다.
#
#   1. `/health` — **실물 nginx + 실물 TLS 인증서**를 통과해서 core-api 에 닿는가
#   2. `/mcp`    — MCP 로 말이 통하고 도구가 5개인가
#
# ## 왜 컨테이너 내부가 아니라 도메인으로 두드리는가
# `http://core-api:3001/health` 를 보면 nginx 설정이 깨져도 초록이 뜬다. 그건
# specs/06 관측 행이 말하는 "`/health` 모니터"가 재는 경로가 아니다. 그래서 실제
# 도메인·TLS·라우팅을 전부 통과시킨다.
#
# ## 왜 EIP 가 아니라 127.0.0.1 로 해소하는가
# EC2 인스턴스는 **자기 자신의 EIP 로 되돌아오지 못한다**(IGW 가 VPC 를 나가는
# 트래픽에만 NAT 를 건다). 그래서 도메인만 로컬로 해소시키고 나머지(TLS SNI·
# 인증서 CN·nginx server_name·라우팅)는 전부 진짜를 쓴다.
# 바깥에서의 도달성(DNS·SG·EIP)은 **워크플로가 러너에서 따로 잰다** — 여기서는 잴 수 없다.
#
# ## 왜 MCP 를 curl 로 안 하는가
# Streamable HTTP 는 `initialize` → `notifications/initialized` → `tools/list`
# 세 왕복이고 세션 헤더가 오간다. 이미 `scripts/mcp-ping.ts` 가 그걸 정확히 하고
# **원인별 종료 코드**까지 가른다(69=미도달, 77=인증, 1=도구 수 불일치). 배포
# 스모크가 알아야 하는 구분이 바로 그거라 그대로 쓴다. 실행기는 방금 배포한
# mcp 이미지다 — tsx 와 node 가 이미 그 안에 있다.
# ===========================================================================
set -euo pipefail

: "${DOMAIN_NAME:?smoke.sh: DOMAIN_NAME 이 필요하다}"
: "${ECR_REGISTRY:?smoke.sh: ECR_REGISTRY 가 필요하다}"
: "${IMAGE_TAG:?smoke.sh: IMAGE_TAG 가 필요하다}"
: "${ENV_FILE:?smoke.sh: ENV_FILE 이 필요하다}"
: "${SMOKE_DIR:?smoke.sh: SMOKE_DIR 이 필요하다}"

log() { printf '[smoke] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1) /health
#
# `--retry-connrefused` 가 있어야 nginx 가 아직 포트를 잡기 전인 순간을 견딘다.
# 재시도 총량은 db-init 대기와 무관하다 — `up -d` 가 이미 그걸 기다리고 왔다.
# ---------------------------------------------------------------------------
log "GET https://${DOMAIN_NAME}/health"
curl -fsS --max-time 15 \
  --retry 10 --retry-delay 3 --retry-connrefused \
  --resolve "${DOMAIN_NAME}:443:127.0.0.1" \
  "https://${DOMAIN_NAME}/health" >/dev/null
log "/health OK"

# ---------------------------------------------------------------------------
# 2) MCP 도구 목록
#
# 키는 .env 의 `API_KEYS` 첫 항목(`key:project` 형식)에서 뽑는다 —
# `tools/loadtest.ts` 가 세운 규약과 같다. 스모크 전용 키를 따로 두면 그 키가
# 만료·회수될 때 스모크만 조용히 빨개진다.
# ---------------------------------------------------------------------------
api_keys="$(sed -n 's/^API_KEYS=//p' "$ENV_FILE" | head -n1)"
[ -n "$api_keys" ] || {
  printf '[smoke] ERROR: %s 에서 API_KEYS 를 읽지 못했다\n' "$ENV_FILE" >&2
  exit 78
}
first_pair="${api_keys%%,*}"
smoke_key="${first_pair%%:*}"
[ -n "$smoke_key" ] || {
  printf '[smoke] ERROR: API_KEYS 첫 항목에서 키를 뽑지 못했다\n' >&2
  exit 78
}

log "MCP tools/list https://${DOMAIN_NAME}/mcp"
# `--network host` + `--add-host` 조합: 컨테이너 안에서도 도메인이 루프백으로
# 해소되고, 그 결과 TLS 인증서 CN 검증이 실제 인증서로 이뤄진다.
# 키는 `-e NAME` 형태로만 넘긴다 — 값이 `docker run` 인자에 실리면 호스트의
# 프로세스 목록에 그대로 보인다.
SENTINEL_KB_KEY="$smoke_key" \
  docker run --rm \
  --network host \
  --add-host "${DOMAIN_NAME}:127.0.0.1" \
  -v "${SMOKE_DIR}/mcp-ping.ts:/smoke/mcp-ping.ts:ro" \
  -v "${SMOKE_DIR}/mcp-ping.cli.ts:/smoke/mcp-ping.cli.ts:ro" \
  -e SENTINEL_KB_URL="https://${DOMAIN_NAME}" \
  -e SENTINEL_KB_KEY \
  "${ECR_REGISTRY}/sentinel-kb-mcp:${IMAGE_TAG}" \
  tsx /smoke/mcp-ping.cli.ts >/dev/null

log "MCP 도구 목록 OK"
log "스모크 통과 (${IMAGE_TAG})"
