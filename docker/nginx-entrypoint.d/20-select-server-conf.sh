#!/bin/sh
# nginx:alpine 기본 엔트리포인트가 `/docker-entrypoint.d/*.sh`를 알파벳 순으로 실행한다.
# 그중 하나로 끼어들어 dev/prod 서버 블록을 고른다 (T-026).
#
# 왜 이미지 두 개가 아니라 스위치 하나인가: 이미지가 갈라지면 라우팅·TLS·스트리밍 설정도
# 언젠가 갈라진다. 갈라지지 않는 것이 이 태스크의 목적이라 **하나의 이미지, 하나의 스위치**다.
set -eu

MODE="${NGINX_MODE:-dev}"
SRC="/etc/nginx/available/${MODE}.conf"
DEST="/etc/nginx/conf.d/default.conf"

if [ ! -f "$SRC" ]; then
    echo "[nginx-entrypoint] NGINX_MODE=${MODE}에 해당하는 ${SRC}가 없다." >&2
    exit 78 # EX_CONFIG
fi

if [ "$MODE" = "prod" ]; then
    if [ -z "${DOMAIN_NAME:-}" ]; then
        # 빈 값으로 envsubst하면 `server_name ;`과 `/etc/letsencrypt/live//fullchain.pem`이
        # 되어 nginx가 난해한 에러로 죽는다. 여기서 원인을 말하고 죽는 편이 싸다.
        echo "[nginx-entrypoint] NGINX_MODE=prod인데 DOMAIN_NAME이 비어 있다." >&2
        exit 78
    fi
    envsubst '${DOMAIN_NAME}' <"$SRC" >"$DEST"
else
    cp "$SRC" "$DEST"
fi

echo "[nginx-entrypoint] NGINX_MODE=${MODE} → ${DEST}"
