# infra — Terraform 최소셋 (T-025)

`specs/06-deployment.md` 의 IaC 행을 구현한다: **VPC/SG/EC2/Route53/ECR/IAM 만. 그 이상 모듈화 안 함.**
애플리케이션 배포(compose 렌더·이미지 푸시·RunCommand)는 T-027 이고 여기 없다.

## 무엇이 만들어지는가

| 리소스    | 내용                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| SG        | 인바운드 **443 하나뿐**. egress 전체 허용. **22 없음**                        |
| EC2       | t3.small 1대, AL2023, IMDSv2 강제, gp3 30GB 암호화, key_name 없음             |
| EIP       | 고정 IP. 재해 복구 시 새 인스턴스에 재연결                                    |
| IAM       | SSM Session Manager, ECR pull, `/{project}/{env}/*` SSM 읽기, CloudWatch Logs |
| ECR       | compose 서비스 5개(nginx/core-api/mcp/worker/web), 최근 20개 유지             |
| Route53   | 기존 존에 A 레코드(TTL 60)                                                    |
| SSM Param | SecureString 4개를 **정의만**. 값은 수동 주입                                 |
| Logs      | `/{project}/{env}/app` 로그 그룹                                              |

VPC 는 만들지 않는다 — 계정 기본 VPC 를 쓴다(`var.vpc_id = null`). 스펙의 "기본 사용 가능 시 생략".

## SSH 를 열지 않는다

`specs/06` 네트워크 행: **SSH 포트 미개방, 접속은 SSM Session Manager.**

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)"
```

이 불변식은 주석이 아니라 `policy/no-ssh-ingress.sh` 가 CI 에서 기계로 지킨다.
`terraform validate` 는 22 를 여는 설정도 "valid" 로 통과시키므로 validate 만으로는 부족하다.

```bash
./infra/policy/no-ssh-ingress.sh              # HCL 정적 스캔 (자격증명 불필요)
./infra/policy/no-ssh-ingress.sh --self-test  # 스캐너 자체가 22 를 잡는지 검증
./infra/policy/no-ssh-ingress.sh --plan plan.json   # plan 된 실제 값으로 재판정 (CI)
```

`--self-test` 는 `policy/fixtures/` 의 **의도적 위반** 파일들(단일 22, 20-443 범위,
`protocol = "-1"`, 레거시 인라인 `ingress`, `aws_security_group_rule`, 변수로 숨긴 포트)을
스캐너가 전부 잡는지, 그리고 정상 443 설정에 거짓 양성을 내지 않는지 확인한다.
**아무것도 잡지 못하는 정책 테스트는 그린을 위조할 뿐이라 이 자기검증을 CI 에 상주시킨다.**
fixture 는 `*.tf.fixture` 라 terraform 이 읽지 않고, 기본 스캔 대상에서도 빠진다.

## 상태 백엔드와 닭-달걀 문제

상태는 S3 백엔드 + DynamoDB 락이다(`backend.tf`). 그런데 **그 S3 버킷 자체는
`infra/` 가 만들 수 없다** — 상태를 저장할 곳이 아직 없기 때문이다.

선택지는 셋이었다.

| 안                                                      | 문제                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| (a) 콘솔에서 손으로 생성                                | 버저닝·암호화·PITR 설정이 코드에 안 남고 재현 불가     |
| (b) `infra/` 가 만들고 나중에 `init -migrate-state`     | 첫 apply 가 2단계 특수 절차. 신규 계정마다 사람이 실수 |
| **(c) 로컬 state 를 쓰는 별도 루트 `infra/bootstrap/`** | ← **채택**                                             |

(c) 의 대가는 "bootstrap 의 state 는 원격에 없다" 인데, 만드는 리소스가 버킷·테이블
둘뿐이고 이름이 결정적(`{project}-tfstate-{account_id}`, `sentinel-kb-tfstate-lock`)이라
state 를 잃어도 `terraform import` 두 줄로 복구된다. 둘 다 `prevent_destroy` 를 건다.
얻는 것은 "백엔드 구성도 코드로 남는다" 이고, 이쪽이 더 크다고 판단했다.

`bucket` 만 `-backend-config` 로 주입한다. S3 버킷 이름은 전역 고유라 계정마다 달라서다.
나머지(key/region/encrypt/dynamodb_table)는 환경 무관 규약이라 `backend.tf` 에 고정했다.

## 최초 구축

```bash
# 1) 백엔드 부트스트랩 (계정당 1회, 로컬 state)
cd infra/bootstrap && terraform init && terraform apply
BUCKET=$(terraform output -raw state_bucket_name)

# 2) 메인 루트
cd .. && cp terraform.tfvars.example terraform.tfvars   # 존 이름·도메인 입력
echo "bucket = \"$BUCKET\"" > backend.hcl
terraform init -backend-config=backend.hcl
terraform apply

# 3) 시크릿 주입 — terraform 은 값을 모른다
for p in MONGODB_URI ANTHROPIC_API_KEY VOYAGE_API_KEY API_KEYS; do
  aws ssm put-parameter --name "/sentinel-kb/prod/$p" \
    --type SecureString --value "<실제값>" --overwrite
done
```

값을 주입하기 전 파라미터에는 `__SET_ME_VIA_AWS_CLI__` 가 들어있다. 시크릿이 아니라
"아직 안 채워졌다"는 표식이며, 배포 스크립트가 이걸 보고 거절할 수 있다.
`lifecycle.ignore_changes = [value]` 때문에 이후 `apply` 는 실제 값을 덮어쓰지 않는다.

## CI 설정

`.github/workflows/infra.yml` 은 잡이 둘이다.

- **static** — fmt / validate / 정책 테스트. **AWS 자격증명이 필요 없어 어디서든 판정된다.**
- **plan** — `terraform plan` + plan JSON 정책 재판정. **자격증명이 필요하다.**

plan 잡은 저장소 변수가 없으면 조용히 건너뛰지 않고 **실패한다**. 자격증명이 없다고
plan 을 스킵한 채 초록을 띄우면 그건 가짜 그린이기 때문이다.

등록할 저장소 변수(Settings → Variables):

| 변수                | 예시                                                        |
| ------------------- | ----------------------------------------------------------- |
| `AWS_PLAN_ROLE_ARN` | `arn:aws:iam::<acct>:role/sentinel-kb-gha-plan` (OIDC 신뢰) |
| `AWS_REGION`        | `ap-northeast-2`                                            |
| `TF_STATE_BUCKET`   | bootstrap 의 `state_bucket_name`                            |
| `ROUTE53_ZONE_NAME` | `example.com`                                               |
| `DOMAIN_NAME`       | `kb.example.com`                                            |

롤은 읽기 권한(`ReadOnlyAccess`) + 상태 버킷 R/W + 락 테이블 R/W 면 plan 에 충분하다.
장기 액세스 키는 쓰지 않는다(OIDC).

## 알려진 제약

- `dynamodb_table` 백엔드 인자는 Terraform 1.11+ 에서 **deprecated** 다(`use_lockfile` 권장).
  동작은 하고 경고만 뜬다. `specs/06` 과 T-025 Acceptance 3 이 "DynamoDB 락"을 명시하므로
  스펙을 먼저 고치기 전에는 바꾸지 않는다(CLAUDE.md 원칙 1).
- `terraform plan` 은 자격증명 없이 판정할 수 없다. 로컬에서 그린을 봤다고 말할 수 없고,
  판정처는 CI 의 `plan` 잡 하나뿐이다.
