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

# ---------------------------------------------------------------------------
# 스왑 2GiB (T-026 F-3 해소).
#
# t3.small 은 2GiB 인데 compose 의 mem_limit 합계가 1,520MiB 다(docker/README.md 결정 2).
# 호스트에 남는 것이 ~320MiB 뿐이라 커널·dockerd·SSM 에이전트·배포 중 `docker pull` 이
# 겹치면 그대로 OOM 이다. compose 가 걸어 둔 `memswap_limit`(상한의 2배)은
# **호스트에 스왑이 없으면 아무 일도 하지 않는다** — 그 값을 유효하게 만드는 것이 여기다.
#
# `fallocate` 가 아니라 `dd` 를 쓴다: fallocate 로 만든 파일은 파일시스템에 따라
# 홀(hole)이 남아 mkswap 이 거절한다.
#
# 스왑은 **정상 경로가 아니라 OOM 대신 맞는 완충재**다. 상시로 스왑에 눌러앉으면
# 지연만 늘고 원인은 감춰지므로 swappiness 를 낮춰 둔다.
# ---------------------------------------------------------------------------
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi

# 재부팅 후에도 붙도록. 중복 추가하지 않는다(user_data 는 재실행될 수 있다).
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab

printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-sentinel-kb-swap.conf
sysctl -p /etc/sysctl.d/99-sentinel-kb-swap.conf

# 배포 번들(compose 파일 + deploy.sh)이 SSM RunCommand 로 여기에 풀린다 (T-027).
install -d -m 0755 /opt/sentinel-kb
