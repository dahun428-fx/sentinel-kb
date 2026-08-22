# docker / compose / nginx — T-026

`specs/06-deployment.md`의 컴퓨트·TLS·nginx·관측 행을 구현한다.
이미지 푸시와 SSM RunCommand 배포는 **T-027**이고 여기 없다.

| 파일                       | 무엇                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `docker-compose.yml`       | 로컬 전체 스택. `pnpm dev:compose`                              |
| `docker-compose.prod.yml`  | 프로덕션 오버레이(ECR·TLS·certbot·awslogs)                      |
| `docker/Dockerfile.node`   | core-api / mcp / worker / db-init 공용                          |
| `docker/Dockerfile.web`    | Next.js                                                          |
| `docker/Dockerfile.nginx`  | 설정을 **구워 넣은** nginx                                       |
| `nginx/snippets/`          | 라우팅·프록시 설정 **정본**. dev·prod가 같은 파일을 include     |
| `nginx/available/`         | dev·prod 서버 블록                                               |

## 로컬 기동

```bash
cp .env.example .env       # MONGODB_URI·API_KEYS·ANTHROPIC_API_KEY·VOYAGE_API_KEY·CORE_API_KEY를 채운다
pnpm dev:compose
curl -sS http://localhost:8080/health
```

상태는 전부 Atlas다(specs/06). 로컬에도 DB 컨테이너가 없고 `MONGODB_URI`가 실 Atlas를 본다.

`db-init`이 먼저 돌아 검색 인덱스를 세우고 **정상 종료한 뒤에야** core-api·worker가 뜬다.
Atlas가 아닌 평범한 mongod를 가리키면 `SEARCH_INDEX_UNSUPPORTED`로 여기서 멈춘다 — 의도된 동작이다.
인덱스 없이 뜬 스택은 첫 검색에서 죽고, 그건 "가끔 검색이 안 됨"으로 보고되어 훨씬 비싸다.

## 프로덕션

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# 최초 1회 — 인증서가 없으면 nginx가 뜨지 않는다 (닭-달걀)
$COMPOSE --profile bootstrap run --rm certbot-init

$COMPOSE up -d
```

`.env`는 손으로 만들지 않는다. SSM Parameter Store(SecureString)에서 배포 시 렌더한다(specs/06).

---

## 결정 1 — certbot은 **DNS-01**이다 (T-025 F-3 해소)

`specs/06`은 두 가지를 동시에 요구하는데 **양립하지 않는다**:

- 네트워크 행: "SG **443만** 인바운드"
- TLS 행: "Let's Encrypt(**certbot**, 자동 갱신 cron)"

HTTP-01 챌린지는 Let's Encrypt가 `http://<domain>/.well-known/acme-challenge/...`로 **80번에**
접속해야 한다. SG가 80을 막고 있으면 발급도 갱신도 실패한다. 스펙에는 챌린지 방식 명시가 없다.

| 안                       | 필요한 것                       | 판정                                                         |
| ------------------------ | ------------------------------- | ------------------------------------------------------------ |
| HTTP-01                  | SG 80 인바운드 개방             | ✗ specs/06 네트워크 행과 정면 충돌                           |
| TLS-ALPN-01              | 443을 certbot이 점유            | ✗ nginx가 443을 들고 있다. 넘기려면 매 갱신마다 다운타임     |
| **DNS-01 (route53)**     | Route53 존 쓰기 권한            | ✓ **채택** — 인바운드를 하나도 열지 않는다                   |

Route53은 `infra/route53.tf`가 이미 만들고 있다. 인스턴스 롤로 인증하므로 정적 키가 필요 없고
(`ec2.tf`가 `http_put_response_hop_limit = 2`로 컨테이너의 IMDS 접근을 이미 열어 두었다),
와일드카드 인증서도 가능해진다.

> ⚠️ **아직 막혀 있다**: 인스턴스 롤에 route53 권한이 없다. `infra/iam.tf`에
> `route53:ListHostedZones`·`route53:GetChange`·`route53:ChangeResourceRecordSets`
> (해당 존으로 한정) 추가가 필요하다. `infra/`는 이 태스크 범위 밖이라 손대지 않았다.
> **그 전까지 `certbot-init`은 실패한다.**

갱신 반영: certbot이 갱신해도 nginx는 이미 로드한 인증서를 계속 쓴다. docker 소켓을
컨테이너에 물리는 것(=사실상 호스트 루트)을 피하려고, nginx가 스스로 12시간마다
graceful reload한다(`docker/nginx-entrypoint.d/30-cert-reload-loop.sh`).

---

## 결정 2 — t3.small 메모리 예산 (T-025 F-2 해소)

t3.small은 **2GiB**이고 컨테이너는 5개다(nginx + Next.js + Fastify + MCP + worker).
Node 프로세스가 4개고 Next.js 런타임만 300–500MB를 쓴다. 여유가 없다.

| 컨테이너 | `mem_limit` | `--max-old-space-size` | 근거                                    |
| -------- | ----------- | ---------------------- | --------------------------------------- |
| nginx    | 48m         | —                      | 프록시. 버퍼링을 껐으므로 버퍼도 안 쓴다 |
| core-api | 448m        | 288                    | 임베딩 호출·검색 결과 직렬화가 가장 무겁다 |
| mcp      | 256m        | 160                    | core-api HTTP 소비만 한다               |
| worker   | 256m        | 160                    | 배치 32건 임베딩                        |
| web      | 512m        | 320                    | Next.js 런타임                          |
| **합계** | **1520m**   |                        | 호스트 여유 ≈ 320m                      |

`db-init`(256m)은 one-shot이고 앱 컨테이너보다 **먼저 끝나므로** 동시 예산에서 뺀다.

두 가지를 함께 건다:

1. **`mem_limit`** — 없으면 커널 OOM killer가 발동하고, 그때 **죽는 대상을 고를 수 없다.**
   상한이 있으면 초과한 컨테이너만 죽고 `restart: unless-stopped`가 되살린다.
2. **`--max-old-space-size`** — 이게 없으면 V8이 **호스트** 메모리(2GiB)를 기준으로 힙을
   키우다 컨테이너 한도에 먼저 부딪혀 **GC가 일할 기회도 없이** OOM-kill 당한다.
   힙 상한을 컨테이너 상한 아래로 두면 그 지점에서 GC가 먼저 돈다.

`tools/compose-contract.int.spec.ts`가 합계와 힙/상한 관계를 기계로 지킨다.

> ⚠️ **호스트 swap이 아직 없다.** `memswap_limit`을 `mem_limit`의 2배로 두었지만
> 호스트에 스왑이 없으면 그 값은 아무 일도 하지 않는다. `infra/user-data.sh`에 2GiB
> 스왑 파일 생성이 필요하다(범위 밖이라 손대지 않았다):
>
> ```bash
> dd if=/dev/zero of=/swapfile bs=1M count=2048
> chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
> echo '/swapfile none swap sw 0 0' >> /etc/fstab
> ```
>
> 스왑은 지연을 늘리므로 **정상 경로가 아니라 OOM 대신 맞는 완충재**다.

---

## 결정 3 — 이미지 무게 (T-014 F-3에 대한 답)

`@modelcontextprotocol/sdk`는 전이 의존 91개를 끌고 오고, 그중 `express`·`jose`·
`pkce-challenge`는 이 레포에서 **한 줄도 실행되지 않는다**(OAuth 경로를 쓰지 않는다).

**그런데 줄일 수 없다.** 셋 다 SDK `package.json`의 `dependencies`에 선언된 **런타임 의존**이라
`--prod`도 `pnpm deploy --prod`도 걷어내지 않고, 강제로 지우면 SDK의 import 그래프가 깨진다.
줄이려면 SDK가 optional peer 또는 subpath exports로 쪼개져야 한다 — **업스트림 사안이다.**

멀티스테이지가 실제로 걷어내는 것은 devDependency 쪽이고, 그쪽이 훨씬 크다
(vitest·playwright·typescript·eslint·mongodb-memory-server + 그 MongoDB 바이너리).

실측(`docker build`, linux/arm64):

| 이미지   | 크기  |
| -------- | ----- |
| core-api | 302MB |
| mcp      | 309MB |
| worker   | 285MB |
| core     | 285MB |

**MCP SDK가 얹는 순증은 core-api 대비 약 7MB다.** 91개라는 개수에 비해 작은데, 대부분이
순수 JS 소형 패키지이기 때문이다. 이 항목은 **더 최적화할 실익이 없다**고 판단했다.

### 왜 tsx로 도는가

워크스페이스 패키지가 `"main": "./src/index.ts"`로 **소스를 노출한다.** `tsc -b`로 dist를
만들어도 `@sentinel/core` import는 여전히 `src/index.ts`로 해소되므로 순수 node로는 뜨지 않는다.
exports 맵을 dist로 돌리는 것은 `packages/**` 수정이라 범위 밖이다. 대신 dev와 **같은 실행기**를
쓰므로 "로컬은 되는데 컨테이너는 안 된다"가 실행기 차이로 생기지 않는다.

tsx는 루트 devDependency라 `--prod` 설치에 딸려 오지 않아 이미지가 따로 설치한다.
그 버전이 lockfile과 갈라지지 않게 `tools/nginx-contract.spec.ts`가 대조한다.

---

## nginx 설정이 갈라지지 않게 하는 구조

```
nginx/snippets/routes.conf          ← 라우팅 정본. dev·prod가 **둘 다** include
        ├── proxy-common.conf       ← 공통 프록시 헤더
        └── proxy-streaming.conf    ← proxy_buffering off / read_timeout 300s
nginx/conf.d/00-upstreams.conf      ← 업스트림만 분리 (테스트가 이 파일만 갈아끼운다)
nginx/available/{dev,prod}.conf     ← 서버 블록. 라우팅을 **복붙하지 않는다**
```

업스트림을 따로 뺀 이유가 핵심이다: `tools/nginx-streaming.int.spec.ts`가 이 파일 하나만
테스트용으로 갈아끼우고 **라우팅·버퍼링 설정은 배포되는 파일 그대로** 검증한다.
설정을 테스트용으로 복사하면 그 테스트는 아무것도 지키지 못한다.

## 무엇이 무엇을 지키는가

| 가드                                | docker 필요 | 지키는 것                                              |
| ----------------------------------- | ----------- | ------------------------------------------------------ |
| `tools/nginx-contract.spec.ts`      | ✗           | specs/06 라우팅표 ↔ 설정, 지시문 존재, 시크릿, tsx 버전 |
| `tools/compose-contract.int.spec.ts`| ✓           | compose가 **해소한 값** (API_KEYS 동일성·메모리·순서)   |
| `tools/nginx-streaming.int.spec.ts` | ✓           | **실물 nginx**를 통과하는 스트리밍의 도착 시각          |
| `tools/require-docker.int.spec.ts`  | —           | CI에서 위 두 개의 skip을 하드 실패로 승격               |

### `proxy_read_timeout` 행동 증명은 옵트인이다

```bash
T026_READ_TIMEOUT_PROOF=1 pnpm test:integration
```

업스트림이 **65초 침묵**해도 스트림이 살아 있는지 본다(nginx 기본값은 60초).
INC-06의 실제 메커니즘이 절단=타임아웃이라 이것이 유일한 직접 증명인데, 한 번에 130초가
걸려 `pnpm verify`에 상시로 얹지 않았다. **끈 상태에서 그 Acceptance는 구조적으로만
지켜진다** — "값이 설정돼 있다"이지 "60초를 견딘다"가 아니다.

## 부하 측정

```bash
pnpm loadtest        # 결과: eval/reports/loadtest-latest.json
```

`/v1/search`의 p95를 NFR-01(1.5s)과 대조한다. **autocannon을 쓰지 않는다** — 그쪽의 백분위
집합이 `[..., 90, 97.5, 99, ...]`로 고정이라 **p95가 없고** 추가 옵션도 없다(autocannon@8.0.0 실측).
p97.5를 p95라 적으면 지어낸 수치다. 근거는 `tools/loadtest.ts` 상단 주석.
