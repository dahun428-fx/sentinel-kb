# 배포 런북 (T-027)

`specs/06-deployment.md` 의 CI/CD·런북 행을 구현한다.
인프라는 T-025(`infra/`), 컨테이너·nginx 는 T-026(`docker/`, `docker-compose*.yml`) 이다.

> ⚠️ **이 문서의 절차는 실제 AWS 계정에서 한 번도 돌지 않았다.** 이 레포에는 자격증명이
> 없어 배포를 판정할 수 없다. 정적으로 대조 가능한 것(이름·경로·순서·권한)은
> `tools/deploy-contract.spec.ts` 가, 롤백의 제어 흐름은 `tools/deploy-rollback.int.spec.ts`
> 가 기계로 지킨다. **그래도 "1회 배포 성공"은 사람이 해봐야 한다.**

---

## 파이프라인

```
main push ─┬─ preflight  저장소 변수 확인 (없으면 실패한다. 스킵하지 않는다)
           └─ verify     pnpm verify (REQUIRE_DOCKER=1)
                  │
              build-push  5개 이미지 → ECR, 태그는 커밋 SHA 하나
                  │
               deploy     SSM RunCommand → 호스트에서 deploy.sh
                            .env 렌더 → pull → 인증서 → up -d → 스모크
                  │
              외부 도달성  러너에서 https://<domain>/health
```

SSH 는 쓰지 않는다. SG 인바운드는 443 하나뿐이고 호스트 조작은 전부 SSM 이다(specs/06).

### 순서가 계약인 지점

| 순서                        | 왜                                                                   |
| --------------------------- | -------------------------------------------------------------------- |
| 인증서 → `up -d`            | nginx prod 블록은 `fullchain.pem` 이 없으면 emerg 로 죽는다          |
| `db-init` → core-api·worker | 인덱스가 PENDING 인 채 뜨면 첫 `/v1/search` 가 죽는다                |
| `up -d` → 스모크            | `up -d` 가 db-init 을 기다리고 온다. 먼저 재면 대기 중에 빨간불      |
| 스모크 → last-good 기록     | 먼저 기록하면 깨진 태그가 롤백 대상이 되어 되돌아갈 곳이 사라진다     |

**`db-init` 은 compose 안에 있다.** `pnpm db:search-indexes` 를 배포 스크립트에서
따로 부르지 않는다 — T-026 이 `service_completed_successfully` 게이트로 만들었고,
밖에서 또 부르면 두 번 돌거나 `up -d` 뒤에 붙어 순서가 뒤집힌다.

> ⚠️ **`specs/06` 런북에는 이 단계가 아직 없다.** T-010 비준 3 → T-026 F-9 → 여기까지
> 세 번 인계됐다. 문면 정정은 사람 승인 사항이라(CLAUDE.md 원칙 1) 하지 않았다.

---

## 저장소 설정

전부 **변수**(Settings → Variables)다. **시크릿은 하나도 없다** — 러너는 애플리케이션
시크릿을 만지지 않고, 호스트가 자기 인스턴스 롤로 Parameter Store 에서 직접 읽는다.

| 변수                  | 예시                                                    |
| --------------------- | ------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<acct>:role/sentinel-kb-gha-deploy` (OIDC) |
| `AWS_REGION`          | `ap-northeast-2`                                        |
| `EC2_INSTANCE_ID`     | `terraform output -raw instance_id`                     |
| `ECR_REGISTRY`        | `<acct>.dkr.ecr.ap-northeast-2.amazonaws.com`           |
| `SSM_PREFIX`          | `terraform output -raw ssm_parameter_prefix`             |
| `LOG_GROUP_NAME`      | `terraform output -raw log_group_name`                  |
| `DOMAIN_NAME`         | `kb.example.com`                                        |
| `CERTBOT_EMAIL`       | 만료 알림 수신 주소                                     |
| `EMBEDDING_MODEL`     | `voyage-3` (코드에 기본값이 없다 — NFR-06)              |
| `ANTHROPIC_MODEL`     | `claude-opus-5`                                         |

하나라도 없으면 `preflight` 가 **exit 1** 한다. `if:` 로 건너뛰게 만들지 마라 —
변수를 등록하지 않은 저장소에서 배포 워크플로가 영원히 초록이 된다(T-025 규약).

### 배포 롤 (OIDC)

장기 액세스 키를 만들지 않는다. GitHub OIDC 공급자를 신뢰하는 롤에 아래만 준다.

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:<region>:<acct>:repository/sentinel-kb-*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:SendCommand"],
      "Resource": [
        "arn:aws:ssm:<region>::document/AWS-RunShellScript",
        "arn:aws:ec2:<region>:<acct>:instance/<instance-id>"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
```

`SendCommand` 를 **특정 인스턴스와 특정 문서로** 좁히는 것이 요점이다. 넓게 주면
이 롤이 계정 안 아무 EC2 에서나 임의 셸을 돌릴 수 있다.

신뢰 정책의 `sub` 는 `repo:<org>/<repo>:ref:refs/heads/main` 으로 고정한다.
`repo:<org>/<repo>:*` 로 두면 **아무 브랜치의 PR 이 배포 롤을 가정할 수 있다.**

`infra/` 가 이 롤을 만들지 않는 이유는 T-025 의 `plan` 롤과 같다: 롤이 있어야 CI 가
돌고, CI 가 돌아야 terraform 이 적용된다 — 닭-달걀이라 계정당 1회 수동이다.

---

## 최초 배포

```bash
# 1) 인프라 (infra/README.md '최초 구축')
cd infra && terraform apply

# 2) 시크릿 주입 — 5개 전부. 하나라도 비면 deploy.sh 가 up -d 전에 거절한다.
for p in MONGODB_URI ANTHROPIC_API_KEY VOYAGE_API_KEY API_KEYS CORE_API_KEY; do
  aws ssm put-parameter --name "/sentinel-kb/prod/$p" \
    --type SecureString --value "<실제값>" --overwrite
done

# 3) 저장소 변수 등록 (위 표)

# 4) main 에 머지 → 워크플로가 나머지를 한다
```

`CORE_API_KEY` 는 `API_KEYS` 에 등록된 키 **중 하나**여야 한다. 갈라지면 웹 UI 만
401 이 난다(`API_KEYS=devkey:sentinel-kb` 면 `CORE_API_KEY=devkey`).

첫 배포에서는 인증서가 없으므로 `deploy.sh` 가 `certbot-init` 을 자동으로 돌린다.
DNS-01(route53)이라 인바운드를 열지 않는다. 실패하면 → "인증서" 절.

---

## 롤백

### 자동 (기본 경로)

`deploy.sh` 가 **호스트에서** 판단한다. 워크플로 쪽 `if: failure()` 가 아닌 이유는,
러너가 죽거나 취소되면 그 스텝이 영영 안 돌아 스택이 깨진 채 남기 때문이다.

```
up -d 실패 또는 스모크 실패
  └→ /opt/sentinel-kb/last-good-tag 를 읽는다
      ├─ 있으면: 그 태그로 .env 재렌더 → pull → up -d → 스모크
      │           성공해도 **워크플로는 실패로 보고한다**
      └─ 없으면(첫 배포): 되돌아갈 곳이 없다. 실패로 끝낸다
```

되감기는 **정확히 1회**다. 두 번 연속 실패는 태그 문제가 아니라 호스트·Atlas·시크릿
문제이고, 계속 되감으면 원인에서 멀어진다.

`last-good-tag` 는 **스모크가 통과한 뒤에만** 갱신된다. 먼저 갱신하면 깨진 태그가
다음 롤백의 목적지가 되어 되돌아갈 곳이 사라진다.

> **T-039 의 설계를 여기서 쓴다.** core-api 는 키가 없으면 부팅을 거부한다. 그래서
> 오설정은 `compose up -d` 가 **즉시** non-zero 로 끝나고, 그것이 그대로 롤백
> 트리거가 된다. `up -d` 뒤에 `|| true` 를 붙이면 그 설계가 통째로 무효가 된다 —
> `deploy-contract.spec.ts` 가 그 한 줄을 지킨다.

### 수동

```
Actions → deploy → Run workflow → image_tag = <되돌릴 커밋 SHA>
```

이미지는 ECR 에 최근 20개가 남는다(`infra/ecr.tf` 라이프사이클). 그보다 오래된
태그로는 되돌릴 수 없고, 그때는 그 커밋을 다시 빌드해야 한다.

### 롤백이 실패했을 때

```bash
aws ssm start-session --target "$(terraform -chdir=infra output -raw instance_id)"
sudo -i && cd /opt/sentinel-kb
COMPOSE="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE ps                      # 무엇이 죽었나
$COMPOSE logs --tail=200 db-init # 인덱스 단계에서 멈췄나
$COMPOSE logs --tail=200 core-api

cat last-good-tag                # 어디로 되돌아가야 하나
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<태그>/' .env && $COMPOSE up -d
```

`db-init` 이 `SEARCH_INDEX_UNSUPPORTED` 로 멈췄으면 `MONGODB_URI` 가 Atlas 가 아닌
평범한 mongod 를 보고 있다. 의도된 실패다 — 인덱스 없이 뜬 스택은 첫 검색에서 죽는다.

---

## 인증서

DNS-01(route53)이다. HTTP-01 은 80 인바운드를 요구해 SG 와 양립하지 않는다
(T-025 F-3, `docker/README.md` 결정 1).

```bash
$COMPOSE --profile bootstrap run --rm certbot-init   # 최초 발급
$COMPOSE logs --tail=100 certbot                      # 갱신 로그
$COMPOSE run --rm certbot certbot renew --dns-route53 --force-renewal
```

**AccessDenied 가 나면** 인스턴스 롤의 route53 권한을 본다. `infra/iam.tf` 의
`Route53AcmeChallengeWriteOnly` 가 그것이고, 쓰기를 `_acme-challenge.<domain>` 의
TXT 로 좁혀 두었다. 도메인을 바꿨는데 `var.domain_name` 을 안 고치면 조건이
안 맞아 여기서 막힌다. 그 경우 `terraform apply` 가 먼저다.

nginx 는 갱신된 인증서를 자동으로 다시 읽지 않으므로 12시간마다 스스로 graceful
reload 한다(`docker/nginx-entrypoint.d/30-cert-reload-loop.sh`).

---

## 재해 복구 (specs/06 "새 EC2 → DNS 스왑")

상태는 전부 Atlas라 호스트는 언제든 버릴 수 있다(NFR-07).

```bash
terraform -chdir=infra taint aws_instance.app
terraform -chdir=infra apply     # EIP 가 새 인스턴스에 다시 붙는다(A 레코드 불변)
```

새 호스트에는 `/opt/sentinel-kb` 가 비어 있다 — **`last-good-tag` 도 없다.**
그래서 복구 직후 첫 배포는 롤백 대상이 없는 상태다. 마지막 성공 SHA 로
`workflow_dispatch` 를 한 번 돌려 last-good 을 세워 두는 것이 안전하다.

user-data 가 docker·compose·**스왑 2GiB**를 깐다. 스왑이 없으면 t3.small 2GiB 에
컨테이너 상한 합계 1,520MiB 라 여유가 ~320MiB 뿐이고, `docker pull` 이 겹치는
순간 OOM 이 난다(T-026 F-3).

---

## 워커 적체 (specs/06 런북)

```bash
$COMPOSE exec -T core-api node -e '…jobs status 집계…'
$COMPOSE logs --tail=200 worker
```

worker 에는 healthcheck 가 없다 — HTTP 표면이 없어서 `exit 0` 을 돌려주는 가짜
체크를 다느니 없는 편이 낫다는 T-026 판단이다. 관측은 `jobs` 집계로 한다.

---

## 무엇이 무엇을 지키는가

| 가드                                  | 지키는 것                                                     |
| ------------------------------------- | ------------------------------------------------------------- |
| `tools/deploy-contract.spec.ts`       | 이미지 이름 3자 대조, 경로 실재, env 전량 렌더, OIDC, 순서    |
| `tools/deploy-rollback.int.spec.ts`   | 롤백의 **실제 제어 흐름** (스텁 aws/docker 로 deploy.sh 실행) |
| `infra/policy/no-ssh-ingress.sh`      | SG 에 22 가 없음                                              |
| `preflight` 잡                        | 저장소 변수 부재 시 **실패** (스킵 아님)                      |

배포 파이프라인은 자격증명이 없으면 아무도 돌려보지 않는다. 그래서 정적으로 판정
가능한 것을 최대한 정적으로 판정하고, 남는 것을 이 문서가 명시한다.
