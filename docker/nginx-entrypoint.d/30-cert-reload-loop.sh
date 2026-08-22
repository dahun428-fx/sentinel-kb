#!/bin/sh
# 인증서 갱신을 nginx에 반영하는 루프 (T-026, prod 전용).
#
# certbot이 갱신해도 **nginx는 이미 로드한 인증서를 계속 쓴다.** 재적재하지 않으면 갱신은
# 성공했는데 서비스는 만료된 인증서를 내미는, 가장 진단하기 나쁜 상태가 된다
# (specs/06 런북 "인증서 갱신 실패"의 이웃 사고다).
#
# certbot 컨테이너가 nginx에 신호를 보내려면 docker 소켓이 필요하다 — 소켓을 컨테이너에
# 물리는 것은 사실상 호스트 루트 권한이라 하지 않는다. 대신 nginx가 **스스로 주기적으로**
# 재적재한다. reload는 graceful이라 진행 중인 스트림을 끊지 않는다.
set -eu

[ "${NGINX_MODE:-dev}" = "prod" ] || exit 0

INTERVAL="${NGINX_RELOAD_INTERVAL:-12h}"

(
    while :; do
        sleep "$INTERVAL"
        nginx -t >/dev/null 2>&1 && nginx -s reload \
            && echo "[nginx-entrypoint] 주기 reload 완료 (인증서 재적재)"
    done
) &

echo "[nginx-entrypoint] ${INTERVAL}마다 reload하는 루프를 띄웠다"
