#!/usr/bin/env bash
# ===========================================================================
# sentinel-kb 호스트 배포 (T-027, specs/06 CI/CD 행).
#
# SSM RunCommand 가 이 스크립트를 호스트에서 root 로 돌린다. GH Actions 러너는
# 이 호스트에 SSH 로 들어올 수 없고(SG 에 22 가 없다), 들어올 필요도 없다.
#
# ## 이 스크립트가 존재하는 이유 — 롤백이 러너가 아니라 호스트에 있어야 한다
# 스모크 실패 시 롤백을 워크플로 쪽 `if: failure()` 스텝으로 두면, **러너가 죽거나
# 취소되는 순간 스택이 깨진 채로 남는다.** 배포를 시작한 주체가 사라져도 복구가
# 끝나 있어야 하므로 롤백 판단을 호스트로 내렸다. 워크플로는 결과를 보고할 뿐이다.
#
# ## 순서가 계약이다
#   1. .env 렌더 (SSM SecureString)
#   2. ECR 로그인 → `compose pull`
#   3. 인증서 확보 (없으면 certbot-init) ← nginx 는 인증서 없이 뜨지 않는다
#   4. `compose up -d`   ← db-init 이 **이 안에서** 먼저 돌고 정상 종료해야 앱이 뜬다
#   5. 스모크 (`/health` + MCP 도구 목록)
#   6. 성공했을 때만 last-good 태그 기록
#
# 4번이 핵심이다. `pnpm db:search-indexes` 를 여기서 **따로 부르지 않는다.**
# T-026 이 `db-init` 서비스를 `service_completed_successfully` 게이트로 만들어
# compose 안으로 넣었기 때문이다. 밖에서 또 부르면 인덱스 생성이 두 번 돌거나,
# 더 나쁘게는 `up -d` **뒤에** 돌아서 core-api 가 인덱스 없이 먼저 뜬다 —
# 그러면 첫 `/v1/search` 가 죽고 그건 "배포 실패"가 아니라 "가끔 검색이 안 됨"으로
# 보고된다(T-010 비준 3, T-026 F-9). specs/06 런북에는 이 단계가 아직 없다(T-027 F-1).
#
# ## 출력에 시크릿을 흘리지 않는다
# `set -x` 를 켜지 않는다. SSM 은 이 스크립트의 stdout/stderr 를 그대로
# `get-command-invocation` 으로 돌려주고 그건 GH Actions 로그에 남는다.
# .env 를 렌더할 때 값을 한 번도 echo 하지 않는 이유가 그것이다.
# ===========================================================================
set -euo pipefail

# 배포 산출물과 상태(.env, last-good 태그)가 사는 곳. 호스트에서는 언제나 기본값이다.
# 덮어쓸 수 있게 둔 이유는 하나뿐이다: **롤백 경로를 실제로 돌려보는 테스트**
# (`tools/deploy-rollback.int.spec.ts`)가 샌드박스에서 이 스크립트를 그대로 실행한다.
# 롤백을 텍스트로만 검사하면 "문장은 있는데 동작은 안 하는" 상태를 못 잡는다.
STATE_DIR="${STATE_DIR:-/opt/sentinel-kb}"
LAST_GOOD_FILE="$STATE_DIR/last-good-tag"
ENV_FILE="$STATE_DIR/.env"

# ---------------------------------------------------------------------------
# 입력. 전부 SSM RunCommand 가 환경변수로 넘긴다.
#
# 여기 없는 값을 기본값으로 흡수하지 않는다 — 오설정이 조용한 기본값으로 덮이면
# "배포는 성공했는데 엉뚱한 곳을 본다"가 된다(시드 INC-07 계열).
# ---------------------------------------------------------------------------
REQUIRED_INPUTS=(
  IMAGE_TAG
  ECR_REGISTRY
  AWS_REGION
  SSM_PREFIX
  LOG_GROUP_NAME
  DOMAIN_NAME
  CERTBOT_EMAIL
  EMBEDDING_MODEL
  ANTHROPIC_MODEL
)

# .env 로 렌더할 SecureString 파라미터.
# **`infra/variables.tf` 의 `secure_parameter_names` 와 글자 그대로 같아야 한다.**
# 경로 전체를 훑지 않고 이름을 명시하는 이유: 누군가 같은 경로에 관계없는 파라미터를
# 넣었을 때 그게 .env 로 새어 들어가면 안 된다.
SECURE_PARAMETERS=(
  MONGODB_URI
  ANTHROPIC_API_KEY
  VOYAGE_API_KEY
  API_KEYS
  CORE_API_KEY
)

# 값이 아직 주입되지 않은 파라미터의 표식(infra/ssm.tf). 시크릿이 아니다.
UNSET_SENTINEL="__SET_ME_VIA_AWS_CLI__"

COMPOSE=(docker compose
  --project-directory "$STATE_DIR"
  --env-file "$ENV_FILE"
  -f "$STATE_DIR/docker-compose.yml"
  -f "$STATE_DIR/docker-compose.prod.yml")

log() { printf '[deploy] %s\n' "$*" >&2; }
die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
check_inputs() {
  local missing=0 name
  for name in "${REQUIRED_INPUTS[@]}"; do
    if [ -z "${!name:-}" ]; then
      printf '[deploy] ERROR: 필수 입력 %s 가 비어 있다\n' "$name" >&2
      missing=1
    fi
  done
  [ "$missing" = "0" ] || die "SSM RunCommand 가 넘긴 환경변수가 부족하다."
}

# ---------------------------------------------------------------------------
# .env 렌더. 값은 한 번도 화면에 나오지 않는다.
#
# `--output text` 는 스칼라 하나를 그대로 돌려준다. 값에 개행이 들어 있으면 .env 가
# 깨지는데, 여기 담기는 것은 URI·키·모델명이라 개행이 있을 수 없다. 개행이 필요한
# 시크릿(예: PEM)이 생기면 이 방식으로는 안 되고 그때 다시 설계해야 한다.
# ---------------------------------------------------------------------------
render_env() {
  local tag="$1" name value
  log ".env 렌더 (SSM ${SSM_PREFIX})"

  umask 077
  : >"$ENV_FILE.tmp"

  for name in "${SECURE_PARAMETERS[@]}"; do
    if ! value="$(aws ssm get-parameter \
      --region "$AWS_REGION" \
      --name "${SSM_PREFIX}/${name}" \
      --with-decryption \
      --query 'Parameter.Value' --output text 2>/dev/null)"; then
      rm -f "$ENV_FILE.tmp"
      die "SSM 파라미터 ${SSM_PREFIX}/${name} 를 읽지 못했다. 인스턴스 롤 권한과 파라미터 존재를 확인하라."
    fi
    if [ "$value" = "$UNSET_SENTINEL" ] || [ -z "$value" ]; then
      rm -f "$ENV_FILE.tmp"
      # 여기서 멈추지 않으면 컨테이너가 뜬 뒤에야 죽고, 그때는 이미 이전 스택이 내려가 있다.
      die "${SSM_PREFIX}/${name} 에 값이 주입되지 않았다(${UNSET_SENTINEL}). infra/README.md '최초 구축' 3번을 보라."
    fi
    printf '%s=%s\n' "$name" "$value" >>"$ENV_FILE.tmp"
  done

  # 시크릿이 아닌 배포 파라미터. compose 가 `:?` 로 요구하는 것들이다.
  {
    printf 'IMAGE_TAG=%s\n' "$tag"
    printf 'ECR_REGISTRY=%s\n' "$ECR_REGISTRY"
    printf 'AWS_REGION=%s\n' "$AWS_REGION"
    printf 'LOG_GROUP_NAME=%s\n' "$LOG_GROUP_NAME"
    printf 'DOMAIN_NAME=%s\n' "$DOMAIN_NAME"
    printf 'CERTBOT_EMAIL=%s\n' "$CERTBOT_EMAIL"
    # 모델명은 코드에 기본값이 없다(NFR-06). 스크립트에도 박지 않는다 —
    # 워크플로의 저장소 변수가 정본이고 여기는 통로일 뿐이다(CLAUDE.md 코드 규칙).
    printf 'EMBEDDING_MODEL=%s\n' "$EMBEDDING_MODEL"
    printf 'ANTHROPIC_MODEL=%s\n' "$ANTHROPIC_MODEL"
  } >>"$ENV_FILE.tmp"

  chmod 0600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# ---------------------------------------------------------------------------
ecr_login() {
  log "ECR 로그인 ($ECR_REGISTRY)"
  aws ecr get-login-password --region "$AWS_REGION" |
    docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null
}

# ---------------------------------------------------------------------------
# 인증서 확보. nginx prod 블록은 `/etc/letsencrypt/live/$DOMAIN_NAME/fullchain.pem`
# 이 없으면 emerg 로 죽으므로 **`up -d` 보다 먼저** 와야 한다.
#
# certbot 은 DNS-01(route53)이다. HTTP-01 은 80 인바운드를 요구해 SG 와 양립하지
# 않는다(T-025 F-3, docker/README.md 결정 1). 인스턴스 롤의 route53 권한은
# `infra/iam.tf` 의 `Route53AcmeChallengeWriteOnly` 가 준다 — 그게 없으면
# 여기서 AccessDenied 로 멈춘다(T-026 F-2, T-027 에서 해소).
# ---------------------------------------------------------------------------
ensure_certificate() {
  local probe="test -f /etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem"
  if "${COMPOSE[@]}" --profile bootstrap run --rm --no-deps \
    --entrypoint sh certbot-init -c "$probe" >/dev/null 2>&1; then
    log "인증서가 이미 있다 — 발급을 건너뛴다 (갱신은 certbot 컨테이너가 12시간마다 한다)"
    return 0
  fi

  log "인증서가 없다 — certbot-init (DNS-01/route53) 최초 발급"
  "${COMPOSE[@]}" --profile bootstrap run --rm certbot-init
}

# ---------------------------------------------------------------------------
# 한 태그를 끝까지 배포한다. 성공하면 0, 어느 단계든 실패하면 non-zero.
#
# `up -d` 뒤에 `|| true` 를 붙이지 않는다. T-039 가 "키가 없으면 부팅을 거부"로 간
# 이유가 바로 여기다 — 오설정이면 컨테이너가 즉시 죽고 `up -d` 가 non-zero 를 내며
# 그것이 그대로 롤백 트리거가 된다. 실패를 삼키면 그 설계가 무효가 된다.
#
# ## ⚠️ 왜 `set -e` 에 기대지 않고 단계마다 `|| return 1` 을 쓰는가
# 이 함수는 `if run_deploy ...; then` 안에서 불린다. **bash 는 조건 문맥에서 불린
# 함수 안의 errexit 을 끈다.** 그래서 `set -euo pipefail` 이 맨 위에 있어도
# `up -d` 가 실패하면 함수가 멈추지 않고 다음 줄로 내려간다. 그러면:
#   새 컨테이너는 못 떴는데 **옛 컨테이너가 아직 서비스 중이라 스모크가 통과**하고
#   → 함수의 반환값이 마지막 명령(스모크)의 0 이 되어 **배포가 성공으로 보고**되고
#   → last-good 이 뜨지도 않은 태그로 갱신되어 다음 롤백의 목적지가 된다.
# 실제로 이 스크립트가 그 상태였고, `tools/deploy-rollback.int.spec.ts` 의
# "`up -d` 만 실패하고 스모크가 통과해도" 테스트가 그것을 잡았다.
# ---------------------------------------------------------------------------
run_deploy() {
  local tag="$1"

  render_env "$tag" || return 1
  ecr_login || return 1

  log "compose pull ($tag)"
  "${COMPOSE[@]}" pull --quiet || return 1

  ensure_certificate || return 1

  # db-init 이 이 안에서 먼저 돌아 B-tree·검색 인덱스를 세우고 정상 종료해야
  # core-api·worker 가 뜬다. 최대 SEARCH_INDEX_READY_TIMEOUT_MS(기본 300초) 동안
  # 블로킹하므로 SSM 쪽 executionTimeout 이 그보다 넉넉해야 한다.
  log "compose up -d ($tag) — db-init 게이트를 통과할 때까지 블로킹한다"
  "${COMPOSE[@]}" up -d --remove-orphans || return 1

  log "스모크 ($tag)"
  IMAGE_TAG="$tag" \
    ECR_REGISTRY="$ECR_REGISTRY" \
    DOMAIN_NAME="$DOMAIN_NAME" \
    ENV_FILE="$ENV_FILE" \
    SMOKE_DIR="$STATE_DIR" \
    "$STATE_DIR/smoke.sh" || return 1
}

# ===========================================================================
main() {
  check_inputs
  cd "$STATE_DIR"

  if run_deploy "$IMAGE_TAG"; then
    printf '%s\n' "$IMAGE_TAG" >"$LAST_GOOD_FILE"
    log "배포 성공: $IMAGE_TAG (last-good 갱신)"
    return 0
  fi

  # -------------------------------------------------------------------------
  # 여기부터 롤백. specs/06 런북 "배포 롤백: 직전 이미지 태그로 compose up -d".
  # -------------------------------------------------------------------------
  log "배포 실패: $IMAGE_TAG"

  # 되감기는 **정확히 1회**다. 재귀하지 않는 이유가 구조에 있다: `main` 은 한 번만
  # 불리고, 롤백은 아래에서 `run_deploy` 를 한 번 더 부를 뿐 자기 자신을 다시 부르지
  # 않는다. "롤백이 실패하면 그 전 태그로 또" 는 의도적으로 하지 않는다 — 두 번 연속
  # 실패는 태그 문제가 아니라 호스트·Atlas·시크릿 문제이고, 계속 되감으면 원인에서
  # 멀어지기만 한다. 그 지점부터는 사람이 봐야 한다.
  local previous=""
  [ -f "$LAST_GOOD_FILE" ] && previous="$(cat "$LAST_GOOD_FILE")"

  if [ -z "$previous" ]; then
    # 첫 배포는 되돌아갈 곳이 없다. 이걸 성공으로 포장하지 않는다.
    die "롤백 대상이 없다(첫 배포이거나 last-good 기록이 없다). 스택이 불완전한 상태로 남았다."
  fi
  if [ "$previous" = "$IMAGE_TAG" ]; then
    die "직전 성공 태그가 방금 실패한 태그와 같다($previous). 되돌릴 곳이 없다."
  fi

  log "롤백 시작: $IMAGE_TAG -> $previous"
  if run_deploy "$previous"; then
    log "롤백 성공: $previous 로 되돌렸다. last-good 은 그대로 둔다."
    # 배포는 실패했다. 롤백이 됐다고 초록을 내면 깨진 커밋이 조용히 main 에 남는다.
    exit 1
  fi

  die "롤백마저 실패했다($previous). 서비스가 내려가 있을 수 있고 **수동 개입**이 필요하다 — docs/runbook.md '롤백이 실패했을 때'."
}

main "$@"
