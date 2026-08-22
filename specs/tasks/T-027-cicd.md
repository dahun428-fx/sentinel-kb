# T-027: CI/CD 배포 파이프라인 (ECR + SSM)
refs: specs/06-deployment.md
M: M6 | deps: T-025, T-026

## Scope
- GH Actions: main 머지 시 verify → 이미지 빌드 → ECR push(태그: sha) → SSM RunCommand로 compose pull/up
- OIDC로 AWS 인증(장기 키 금지)
- 배포 후 `/health`와 MCP 도구 목록 스모크 체크, 실패 시 직전 태그로 롤백
- 배포 런북 `docs/runbook.md`

## Out of scope
- 블루/그린

## Acceptance
- [ ] 실제 배포 1회 성공 + 스모크 통과 — **판정 불가(자격증명 없음)**. F-6
- [ ] 의도적 실패 이미지로 롤백 동작 검증 — **부분**: 제어 흐름은 검증, 실이미지는 판정 불가. F-6
- [x] 워크플로에 정적 AWS 키가 없음(OIDC 사용) 검증
- [x] `pnpm verify` 그린 — **단, 베이스라인 선결 조건 있음.** F-0

## Context budget
- 읽기: specs/06, .github/workflows/**, docs/runbook.md

---

## Findings (T-027)

### F-0 🚨 `package.json` 이 **머지 충돌 마커를 커밋한 채**다 — 범위 밖, 미해결

`integration/m3`(ccf4e8b)의 `package.json` 26–39행에 `<<<<<<< HEAD` / `=======` /
`>>>>>>>` 가 그대로 들어 있다. **JSON 이 아니라서 `pnpm install` 이 시작조차 못 한다:**

```
Volta error: Could not parse project manifest
```

즉 이 브랜치는 **어떤 태스크도 verify 할 수 없는 상태로 시작한다.** T-013/T-016/
T-021/T-040 의 3-way 머지 잔재로 보인다.

해소는 **합집합 한 벌**이고 모호하지 않다 — 세 갈래가 요구하는 CLI 7개가 전부 실재한다
(`eval/{retrieval,generation,tools,injection}/*.cli.ts`):

```json
"eval:retrieval", "eval:retrieval:check",
"eval:generation", "eval:generation:check",
"eval:tools", "eval:tools:check",
"eval:injection"
```

> **커밋하지 않았다.** `package.json` 은 이 태스크의 범위 밖이고(오케스트레이터 지시:
> 범위는 `.github/workflows/`·`infra/`·`docs/`·`tools/`·`specs/tasks/T-027-*.md`),
> task-loop 의 "budget 밖 파일을 **수정해야** 하면 중단 사유" 에 정확히 해당한다.
> 아래 verify 결과는 **위 합집합을 로컬에서 임시 적용한 상태**에서 측정한 것이고,
> 그 수정은 커밋에 들어 있지 않다. 누군가 한 번 고쳐야 하며 그 결정은 사람 몫이다.

### F-1 ⚠️ `specs/06` 런북에 인덱스 부트스트랩 단계가 **여전히 없다** (3번째 인계)

T-010 비준 3 → T-026 F-9 → 여기까지 왔다. `db:search-indexes` 는 기본 300초까지
블로킹하고 **compose up 이전인지 이후인지가 첫 검색 성공을 가른다.**

구현은 T-026 이 만든 `db-init` 게이트에 맞췄다 — `deploy.sh` 는 인덱스 생성을
**따로 부르지 않고** `compose up -d` 안의 `service_completed_successfully` 에 맡긴다.
밖에서 또 부르면 두 번 돌거나 `up -d` 뒤에 붙어 순서가 뒤집힌다.

`specs/06` 런북에 이 단계를 신설하는 문면 정정이 필요하다. **스펙 수정은 인간 승인
사항이라(CLAUDE.md 원칙 1) 하지 않았다.** `docs/runbook.md` 가 임시로 문서화한다.

### F-2 ✅ T-026 F-2 해소 — 인스턴스 롤에 route53 DNS-01 권한 추가

`infra/iam.tf` 에 `ListHostedZones` / `GetChange` / `ListResourceRecordSets` /
`ChangeResourceRecordSets` 를 넣었다. **이게 없어서 `certbot-init` 이 실패했고,
인증서가 없으면 nginx prod 블록이 뜨지 않아 배포가 완결되지 않았다.**

쓰기는 `_acme-challenge.<domain>` 의 **TXT 하나로** 좁혔다
(`ChangeResourceRecordSetsNormalizedRecordNames` + `...RecordTypes` 조건).
존 전체 쓰기를 주면 앱 호스트가 탈취당했을 때 A 레코드를 갈아끼울 수 있다 —
도메인을 통째로 넘겨주는 것과 같다. 와일드카드 인증서도 챌린지 이름이 같아 그대로 된다.

> 대가: 도메인을 바꾸고 `var.domain_name` 을 안 고치면 조건이 안 맞아 발급이 막힌다.
> 조용히가 아니라 `certbot-init` 이 AccessDenied 로 크게 실패하고, `docs/runbook.md`
> "인증서" 절이 그 증상을 지목한다.

### F-3 🚨 ECR 리포지토리 이름이 어긋나 있었다 — compose 가 **없는 이미지를 당기고 있었다**

`infra/ecr.tf` 가 `sentinel-kb/core-api`(슬래시)를 만드는데
`docker-compose.prod.yml` 은 `sentinel-kb-core-api`(하이픈)를 당긴다.

**terraform apply 도 이미지 push 도 성공하고, 배포 **마지막 단계의 pull 에서만** 404 로
죽는다.** 가장 늦게, 가장 비싸게 드러나는 형태다. T-025·T-026 어느 쪽 Findings 에도
없다 — 두 태스크가 각자 범위 안에서는 옳았고 **아무도 둘을 맞대 보지 않았다.**

compose(T-026)를 정본으로 두고 `infra/ecr.tf` 를 하이픈으로 맞췄다. 이제 세 곳
(terraform 목록 · 워크플로 매트릭스 · compose 이미지)을
`tools/deploy-contract.spec.ts` 가 기계로 묶는다.

### F-4 🚨 `CORE_API_KEY` 가 SSM 파라미터 목록에 없었다 — 첫 배포가 `up -d` 에서 죽는다

`docker-compose.yml` 의 web 서비스가 `CORE_API_KEY:?` 로 **요구**하는데(T-026),
`infra/variables.tf` 의 `secure_parameter_names` 는 4개뿐이었다(T-025). 그대로면
`.env` 에 그 키가 없어 compose 가 거절한다.

`infra/variables.tf` 에 추가했다. 이후로는 "compose 가 `:?` 로 요구하는 모든 변수를
`deploy.sh` 가 렌더하는가"를 테스트가 전량 대조하므로 같은 누락이 다시 날 수 없다.

### F-5 🚨 `set -e` 는 조건 문맥의 함수 안에서 **꺼진다** — 롤백이 무력화돼 있었다

`run_deploy` 를 `if run_deploy ...; then` 으로 부르는데, **bash 는 조건 문맥에서
불린 함수 안의 errexit 을 끈다.** `set -euo pipefail` 이 맨 위에 있어도 `up -d` 가
실패하면 함수가 멈추지 않고 다음 줄로 내려갔다.

그 결과가 고약하다:

```
up -d 실패(새 컨테이너 못 뜸) → 옛 컨테이너가 아직 서비스 중 → 스모크 통과
  → 함수 반환값이 마지막 명령(스모크)의 0  → **배포 성공으로 보고**
  → last-good 이 **뜨지도 않은 태그**로 갱신  → 다음 롤백의 목적지가 그 깨진 태그
```

즉 롤백 체계 전체가 조용히 무효였다. 단계마다 `|| return 1` 로 고쳤다.

> **이건 뮤테이션이 잡았다.** `|| true` 뮤테이션이 행동 테스트에서 살아남길래
> "왜 안 죽지"를 파고들다 발견했다. 텍스트 가드만 있었으면 못 봤다 —
> `|| true` 는 없었고 코드는 "맞아 보였다".

### F-6 판정 불가 항목 — **통과로 적지 않는다**

AWS 자격증명이 없어 실제 배포를 돌릴 수 없다.

| Acceptance | 판정 | 근거 |
| --- | --- | --- |
| 1. 실제 배포 1회 성공 + 스모크 | **판정 불가** | 계정·도메인·Atlas 가 없다 |
| 2. 의도적 실패 이미지로 롤백 | **부분** | 제어 흐름은 `deploy-rollback.int.spec.ts` 가 진짜 `deploy.sh` 를 스텁 aws/docker 로 돌려 검증(14). **실제 이미지·실제 컨테이너로는 판정 불가** |
| 3. 정적 AWS 키 없음(OIDC) | **PASS** | `deploy-contract.spec.ts`. 뮤테이션 M3 로 확인 |
| 4. `pnpm verify` 그린 | **PASS** | 단 F-0 선결 |

**판정처를 하나라도 만드는 것**이 이 태스크에서 할 수 있는 최선이라 보고,
정적으로 대조 가능한 것(이름·경로·순서·권한·예산)을 전부 테스트로 내렸다.
남은 것은 **자격증명이 있는 사람의 1회 배포**다.

### F-7 뮤테이션 결과 — 18/18 kill, 생존자 없음

| 뮤테이션 | 판정 |
| --- | --- |
| 배포 잡을 `if:` 로 스킵 / preflight `exit 0` | KILLED |
| OIDC → 장기 액세스 키 | KILLED |
| 워크플로가 없는 스크립트 참조 | KILLED |
| 롤백 블록 제거 (텍스트·행동 양쪽) | KILLED |
| `up -d` 를 `\|\| true` 로 삼킴 (텍스트·행동 양쪽) | KILLED |
| 인덱스 부트스트랩을 `up -d` 뒤로 | KILLED |
| 인증서 확보를 `up -d` 뒤로 | KILLED |
| last-good 을 스모크 **전에** 기록 | KILLED |
| ECR 이름 `/` 로 회귀 | KILLED |
| route53 권한 제거 / 범위 조건 제거 | KILLED |
| 호스트 스왑 제거 / 512MiB 로 축소 | KILLED |
| 스모크에서 MCP 도구 목록 제거 | KILLED |
| 스모크가 nginx 우회 | KILLED |

`|| true` 행동 뮤테이션은 처음에 **살아남았고**, 그것이 F-5 를 찾게 했다.
생존자를 숨기지 않은 것이 실제로 버그를 하나 잡았다.

### F-8 범위 밖으로 남긴 것

- **`docker/Dockerfile.node` 주석이 `tools/docker-contract.spec.ts` 를 가리킨다.**
  그런 파일은 없다(실제 파일은 `tools/nginx-contract.spec.ts`). 한 단어 수정.
- **`docs/connect.md` §5 의 거짓 문장** — T-026 F-7 이 이미 지목했고 아직 그대로다.
- **verify 가 `ci.yml` 과 `deploy.yml` 에서 두 번 돈다.** 의도한 중복이다(배포가 자기
  게이트를 가져야 한다). 비용이 문제가 되면 `workflow_run` 으로 묶을 수 있지만
  그쪽은 "어느 커밋의 verify 인가"가 흐려진다.
- **배포 롤(`sentinel-kb-gha-deploy`)을 terraform 으로 만들지 않았다.** T-025 의
  `plan` 롤과 같은 닭-달걀이라 같은 선례를 따랐다(계정당 1회 수동).
  정책 JSON 은 `docs/runbook.md` 에 있다.
