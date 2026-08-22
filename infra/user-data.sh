#!/usr/bin/env bash
# 앱 호스트 부트스트랩. 런타임만 깐다 — 애플리케이션 배포는 T-027 몫이다.
set -euxo pipefail

dnf install -y docker
systemctl enable --now docker

# compose v2 플러그인 (dnf 리포에 없어 릴리스 바이너리를 쓴다)
install -d /usr/local/lib/docker/cli-plugins
curl -fsSL \
  "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose

# SSM Agent 는 AL2023 에 기본 탑재. 접속 경로가 이것뿐이라 기동을 명시 보장한다.
systemctl enable --now amazon-ssm-agent

install -d -m 0755 /opt/sentinel-kb
