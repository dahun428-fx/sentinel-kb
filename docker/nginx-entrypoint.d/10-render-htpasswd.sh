#!/bin/sh
# ===========================================================================
# web 표면(`/`) basic 인증 자격증명을 파일로 렌더한다 (T-042).
#
# nginx:alpine 기본 엔트리포인트가 `/docker-entrypoint.d/*.sh`를 알파벳 순으로 돌린다.
# 번호가 `20-select-server-conf.sh`보다 **앞**인 것은 의도적이다 — 서버 블록을 고르기
# 전에 자격증명이 준비돼 있어야 하고, 실패한다면 nginx가 뜨기 전에 실패해야 한다.
#
# ## 왜 파일이 아니라 base64 env로 받는가 (인간 승인 결정)
# 배포는 SSM Parameter Store → `.env` 렌더 경로 하나로 시크릿을 나른다
# (`infra/deploy/deploy.sh`). 그 경로는 `aws ssm get-parameter --output text`를 쓰는
# **스칼라 전용**이라 개행이 들어가면 `.env`가 깨진다 — 스크립트 자신이 103-106행에
# 그렇게 적어 뒀다. htpasswd는 사용자가 둘 이상이면 여러 줄이다.
# base64로 감싸면 개행 없는 단일 값이 되어 **기존 경로에 그대로 얹히고**, 다중 사용자를
# 포기하지 않아도 된다. 디코딩은 여기, 값을 쓰는 순간 딱 한 번 일어난다.
#
# ## 출력에 자격증명을 흘리지 않는다
# 디코딩 결과를 **한 번도 echo하지 않는다.** 로그는 CloudWatch로 가고(specs/06 관측 행)
# 배포 로그는 SSM `get-command-invocation`을 거쳐 GH Actions에 남는다. 여기서 해시가
# 새면 회수할 방법이 없다. 성공 로그에 담는 것은 **줄 수**뿐이다.
#
# ## 왜 nginx의 500에 맡기지 않는가 (T-042 F-2)
# 파일이 없으면 nginx는 `/`에 500을 낸다. 닫히는 방향이라 안전하긴 하지만 **원인을
# 말하지 않는다** — 운영자는 "사이트가 깨졌다"만 보고 auth_basic_user_file을 의심하기까지
# 한참을 헤맨다. `20-select-server-conf.sh`가 `DOMAIN_NAME`에 대해 하는 것과 같이
# 여기서 이름을 대고 죽는다(exit 78 = EX_CONFIG).
# ===========================================================================
set -eu

# `NGINX_PREFIX`는 **테스트 seam이다.** 컨테이너에서는 언제나 기본값이며,
# `tools/nginx-contract.spec.ts`가 docker 없이 이 스크립트를 실제로 실행해
# 78 경로와 "해시가 로그에 안 나온다"를 재려고 임시 디렉터리를 가리킨다.
PREFIX="${NGINX_PREFIX:-/etc/nginx}"
DEST="$PREFIX/secrets/htpasswd"
TMP="$DEST.tmp"

fail() {
    echo "[nginx-entrypoint] $1" >&2
    exit 78 # EX_CONFIG
}

if [ -z "${WEB_HTPASSWD_B64:-}" ]; then
    fail "WEB_HTPASSWD_B64가 비어 있다. web 표면(\`/\`)은 basic 인증 뒤에 있고(T-042), 자격증명 없이는 뜨지 않는다. 만드는 법은 .env.example의 WEB_HTPASSWD_B64 주석을 보라."
fi

mkdir -p "$PREFIX/secrets"
umask 077
rm -f "$TMP"

# stderr를 버리는 이유: base64 구현에 따라 실패 메시지에 입력 조각이 실릴 수 있다.
# 사유는 아래 우리 문장으로 말한다.
if ! printf '%s' "$WEB_HTPASSWD_B64" | base64 -d >"$TMP" 2>/dev/null; then
    rm -f "$TMP"
    fail "WEB_HTPASSWD_B64를 base64로 디코딩하지 못했다. 값이 잘렸거나 base64가 아니다. (값 자체는 로그에 남기지 않는다)"
fi

# 디코딩은 됐는데 내용이 htpasswd가 아닐 수 있다 — 예를 들어 평문 암호를 그대로
# base64한 경우다. 그러면 nginx는 **모든 로그인을 조용히 거절한다.** 그건 "닫혔다"가
# 아니라 "아무도 못 들어온다"이고, 증상이 인증 실패라 원인을 찾기 어렵다.
# `grep -c`는 개수만 낸다 — 내용을 출력하지 않는다.
lines="$(grep -cE '^[^:[:space:]]+:.+$' "$TMP" 2>/dev/null || true)"
if [ "${lines:-0}" -eq 0 ]; then
    rm -f "$TMP"
    fail "디코딩 결과가 htpasswd 형식이 아니다(\`사용자:해시\` 줄이 하나도 없다). htpasswd 파일 전체를 base64해야 한다 — 암호만 base64하면 안 된다."
fi

# nginx 워커는 root가 아니라 nginx 사용자로 돌고, auth_basic_user_file을 **워커가** 읽는다.
# 그래서 소유권을 넘기고 0640으로 조인다. root가 아니거나 nginx 그룹이 없는 환경
# (유닛 테스트 샌드박스)에서는 0644로 내려간다 — 읽히지 않으면 nginx가 500을 내고
# 그건 이 스크립트가 막으려던 바로 그 증상이다.
if chown root:nginx "$TMP" 2>/dev/null; then
    chmod 0640 "$TMP"
else
    chmod 0644 "$TMP"
fi

mv "$TMP" "$DEST"
echo "[nginx-entrypoint] htpasswd 렌더 완료 (${lines}줄) → ${DEST}"
