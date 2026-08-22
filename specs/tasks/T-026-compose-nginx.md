# T-026: Docker Compose + nginx (SSE/MCP 버퍼링)
refs: specs/06-deployment.md
M: M6 | deps: T-019

## Scope
- 서비스별 멀티스테이지 Dockerfile (api/mcp/worker/web)
- `docker-compose.yml` + nginx conf: `/mcp`, `/v1`, `/` 라우팅
- **`proxy_buffering off`, read timeout 300s** — SSE·MCP 스트리밍 필수
- certbot 컨테이너 + 갱신 cron
- 헬스체크·재시작 정책·로그 드라이버
- 간단 부하 스크립트(autocannon): /v1/search p95 측정, 결과를 eval/reports/에 기록 (NFR-01, 감사 B-4)

## Out of scope
- CI 연동(T-027)

## Acceptance
- [ ] 로컬 `pnpm dev`(compose)로 전 서비스 기동 후 `/health` 200
- [x] SSE 스트리밍이 nginx 경유로 청크 단위 도달함을 검증하는 통합 테스트
- [x] MCP 클라이언트가 nginx 경유로 도구 목록 조회 성공
- [x] 부하 스크립트가 p95 수치를 리포트로 남김
- [x] `pnpm verify` 그린

## Context budget
- 읽기: specs/06, docker-compose.yml, infra/nginx/**

---

## Findings (T-026)

### F-1 ⚠️ specs/06 nginx 라우팅표 정정 필요 (인간 비준 대기)

**두 군데가 실제 요구와 어긋난다.**

1. **`proxy_buffering off`가 `/mcp`에만 적혀 있다.** 그런데 `/v1/answer`도
   `text/event-stream`으로 답한다(T-019). `/v1`이 버퍼링된 채 남으면 INC-06이 MCP가 아니라
   core-api 쪽에서 그대로 재발한다. → 구현은 **`/mcp`·`/v1` 양쪽**에 걸었다.
   specs/06:18을 `/v1` 행에도 같은 단서가 붙도록 고쳐야 한다.

2. **라우팅표에 `/health`가 없다.** 그런데 같은 문서의 관측 행이 "`/health` 모니터"를
   요구하고 SG는 443만 연다. 표대로면 외부 모니터의 `/health`는 `/` 규칙에 걸려 **web UI**로
   간다 — core-api가 죽어도 초록인 모니터다. → `location = /health`(exact match)를 추가했다.
   specs/06 라우팅표에 이 줄을 넣는 정정이 필요하다.

`tools/nginx-contract.spec.ts`가 스펙 표를 파싱해 대조하며, 초과 라우트를 `= /health`
하나로 못박아 두었다. 스펙이 정정되면 그 허용 목록을 지우면 된다.

### F-2 ⚠️ certbot은 DNS-01로 결정. **infra/iam.tf 변경이 남아 있다**

`specs/06`이 "SG 443만"과 "certbot"을 동시에 요구하는데 **HTTP-01은 80번 인바운드를
요구해 양립하지 않는다**(T-025 F-3). 스펙에 챌린지 방식 명시가 없어 결정했다:

| 안               | 판정                                                       |
| ---------------- | ---------------------------------------------------------- |
| HTTP-01          | ✗ SG 80 개방 필요 — specs/06 네트워크 행과 정면 충돌       |
| TLS-ALPN-01      | ✗ nginx가 443을 점유. 넘기려면 갱신마다 다운타임           |
| **DNS-01(route53)** | ✓ **채택** — 인바운드를 하나도 열지 않는다              |

Route53은 이미 있고(`infra/route53.tf`), 인스턴스 롤로 인증하므로 정적 키가 없다
(`ec2.tf`의 `http_put_response_hop_limit = 2`가 컨테이너 IMDS 접근을 이미 열어 두었다).

> **남은 일**: 인스턴스 롤에 `route53:ListHostedZones`·`GetChange`·`ChangeResourceRecordSets`
> (해당 존 한정) 추가. `infra/`는 이 태스크 범위 밖이라 손대지 않았다.
> **그 전까지 `certbot-init`은 실패한다.** 근거는 `docker/README.md` "결정 1".

### F-3 ⚠️ t3.small 메모리: 상한을 걸었으나 **호스트 swap이 없다**

2GiB에 컨테이너 5개(T-025 F-2). `mem_limit` 합계를 **1520MiB**로 잡아 호스트에 약 320MiB를
남겼고, 여기에 `--max-old-space-size`를 각 컨테이너 상한 아래로 못박았다. 후자가 없으면
V8이 **호스트** 메모리 기준으로 힙을 키우다 컨테이너 한도에 먼저 부딪혀 **GC 기회 없이**
OOM-kill 당한다. 표는 `docker/README.md` "결정 2".

> **남은 일**: `memswap_limit`을 상한의 2배로 뒀지만 **호스트에 스왑이 없으면 무효다.**
> `infra/user-data.sh`에 2GiB 스왑 파일 생성이 필요하다(범위 밖). 스니펫은 README에 있다.

`tools/compose-contract.int.spec.ts`가 합계와 힙/상한 관계를 기계로 지킨다.

### F-4 MCP SDK 이미지 무게 — **더 줄일 수 없다** (결론)

`express`·`jose`·`pkce-challenge`는 한 줄도 실행되지 않지만 SDK `package.json`의
**`dependencies`에 선언된 런타임 의존**이다. `--prod`도 `pnpm deploy --prod`도 걷어내지
못하고, 지우면 import 그래프가 깨진다. **업스트림(SDK)이 optional peer / subpath exports로
쪼개져야 하는 사안이다.**

멀티스테이지가 실제로 걷어내는 것은 devDependency 쪽(vitest·playwright·typescript·eslint·
mongodb-memory-server + MongoDB 바이너리)이고 그쪽이 훨씬 크다. 실측:

| 이미지 | 크기 | | 이미지 | 크기 |
| --- | --- | --- | --- | --- |
| core-api | 302MB | | worker | 285MB |
| mcp | 309MB | | web | 828MB |

**MCP SDK의 순증은 core-api 대비 약 7MB다** — 전이 의존 91개 대비 작다. 최적화 실익 없음으로 판단.

> **별건**: `web`이 828MB다. `packages/web/next.config.mjs`에 `output: "standalone"`을 넣으면
> 크게 줄지만 `packages/**` 수정이라 범위 밖이다. 후속 태스크 후보.

### F-5 atlas-local 이미지 캐싱 — 구현했으나 **효과는 판정 불가**

`docker save`/`load` + `actions/cache`. 키에 **주(week)를 넣었다** — 태그가 `:latest`라
키가 고정이면 캐시가 아니라 **의도치 않은 영구 핀**이 된다. 주 단위 회전이면 최대 일주일까지만
낡고, 그 기간 동안은 모든 실행이 같은 이미지를 보므로 움직이는 `:latest`를 매번 pull하는
것보다 재현성이 낫다.

> **판정 불가**: 1.95GB 이미지의 캐시 복원이 pull보다 실제로 빠른지는 **CI에서만 측정된다.**
> 로컬에서 판정할 수 없다. 첫 몇 실행의 소요를 보고 이득이 없으면 해당 3스텝을 지우면 된다.

### F-6 REQUIRE_DOCKER 게이트 (T-010 F-5 해소)

`tools/require-docker.int.spec.ts` + CI의 `REQUIRE_DOCKER: "1"`. docker가 없으면 atlas-local
의존 스펙들이 통째로 skip되고 **exit 0**이 나던 구멍을 닫는다. **배너는 게이트가 아니다.**
로컬은 기본 off — 판정처를 CI 하나로 모으는 것이 요점이지 모두를 불편하게 만드는 게 아니다.

`packages/core`의 `dockerAvailable()`을 재사용하지 않고 3줄을 다시 쓴 이유: tools가
packages/core를 참조하면 `tsc -b` 프로젝트 참조 추가가 필요한데 그건 범위 밖이다.

### F-7 `.env.example` 누락 6종 추가 (T-014 F-2, T-023 F-3 해소)

MCP 4종(`CORE_API_URL`·`CORE_API_TIMEOUT_MS`·`CORE_API_MAX_ATTEMPTS`·`SENTINEL_KB_KEY`) +
웹 2종(`CORE_API_URL`·`CORE_API_KEY`). `CORE_API_URL`은 MCP·웹이 **공유한다** — 둘 다
core-api를 소비하고 주소가 갈라질 이유가 없다. 배포/compose 전용 블록도 함께 넣었다.
`tools/nginx-contract.spec.ts`가 존재를 잠근다.

> **남은 일(문서)**: `docs/connect.md` §5 말미의 "⚠️ … **아직 `.env.example`에 없다**(T-014 F-2).
> T-026에서 … 추가될 예정" 문장이 **이제 거짓이다.** `docs/`는 이 태스크 범위 밖이라
> 고치지 않았다. 한 문단 삭제가 필요하다.

### F-8 API_KEYS 동일성 (T-014 D-5) — compose 앵커 + 해소값 대조

MCP는 호출자 Bearer를 그대로 core-api로 넘긴다(confused deputy 방지). 두 값이 갈라지면
**연결도 도구 목록도 정상인데 도구 호출 시점에만** 401이 난다. 두 프로세스는 서로의 env를
모르므로 **코드로는 탐지 불가**다.

→ `x-shared-auth` 앵커 **하나**를 두 서비스가 참조한다. 방어선이 둘:
`nginx-contract.spec.ts`가 "정의가 한 곳뿐인가"를, `compose-contract.int.spec.ts`가
`docker compose config`의 **해소된 값이 글자 그대로 같은가**를 본다.

### F-9 인덱스 부트스트랩 순서 (T-010 비준 3 해소) — `db-init` one-shot

`pnpm db:search-indexes`가 기본 300초까지 블로킹하고 Atlas·atlas-local에서만 돈다.
**compose up 이전인지 이후인지가 첫 검색 성공을 가른다.** 인덱스가 PENDING인 채 core-api가
뜨면 첫 `/v1/search`가 죽고, 그건 배포 실패가 아니라 "가끔 검색이 안 됨"으로 보고된다.

→ `db-init` 서비스(`restart: "no"`)가 B-tree·검색 인덱스를 세우고 **정상 종료한 뒤에야**
core-api·worker가 뜬다(`service_completed_successfully`). 멱등하므로 재기동마다 다시 돌아도
이미 READY면 즉시 끝난다.

> **남은 일**: `specs/06` 런북에 이 단계가 **여전히 없다.** 배포 절차 신설이 필요하다.

### F-10 autocannon을 쓰지 않았다 (Scope와의 의도적 차이)

Scope가 autocannon을 지목하지만 **쓸 수 없다**. 실제로 설치해 확인한 결과, autocannon의
백분위 집합은 `hdr-histogram-percentiles-obj`가 `[…, 90, 97.5, 99, …]`로 고정하고 있고
**95가 없으며 추가하는 옵션도 없다**(autocannon@8.0.0 실측).

NFR-01과 이 태스크의 Acceptance는 둘 다 **p95**다. p97.5를 p95라 적으면 지어낸 수치이고,
p90으로 대신하면 기준을 느슨하게 만든 것이다. → nearest-rank로 직접 계산한다
(`tools/loadtest.ts`). 보간하지 않는 이유는 **보간된 p95는 실제로 일어나지 않은 지연**이라
리포트에서 원인을 되짚을 수 없기 때문이다. 부수 효과로 의존성이 하나도 늘지 않았다.

### F-11 스트리밍 가드가 실제로 무엇을 잡는지 (뮤테이션 실측)

가드를 만든 뒤 설정을 일부러 깨뜨려 확인했다. **결과가 직관과 달라 기록해 둔다.**

| 뮤테이션                      | 텍스트 가드 | 도착시각 테스트(`/v1`) | 도착시각 테스트(`/mcp`) | 65초 침묵 프로브 |
| ----------------------------- | ----------- | ---------------------- | ----------------------- | ---------------- |
| `proxy_buffering off` 제거    | **빨강**    | 초록                   | 초록                    | 초록             |
| `proxy_read_timeout 300s` 제거| **빨강**    | 초록                   | 초록                    | **빨강 (60.0s)** |

1. **nginx 1.29는 `proxy_buffering on`이어도 작은 SSE 프레임을 즉시 흘린다.** 그래서
   도착시각 테스트로는 그 지시문의 부재를 잡지 못한다. 잡는 것은 텍스트 가드다.
   (`/v1`은 애초에 코드가 `X-Accel-Buffering: no`를 보내 nginx가 그 응답만 버퍼링을 끈다 —
   그래서 오리진이 그 헤더를 **내지 않는** `/mcp` 경로를 대조군으로 따로 두었다.)
2. **INC-06의 진짜 메커니즘은 절단=타임아웃이다.** 65초 침묵 프로브가 그것을 직접 재고,
   `300s`를 지우면 **정확히 60.03초에** 끊긴다 — nginx 기본값 그대로다.

→ 도착시각 테스트는 "스트리밍이 실제로 흐른다"(Acceptance 2)를 증명하고,
지시문 회귀는 텍스트 가드 + 침묵 프로브가 잡는다. **셋 다 필요하고 역할이 다르다.**

> ⚠️ 침묵 프로브는 한 번에 130초가 걸려 **기본 off**다(`T026_READ_TIMEOUT_PROOF=1`).
> 끈 상태에서 `proxy_read_timeout`은 **구조적으로만** 지켜진다 — "값이 설정돼 있다"이지
> "60초를 견딘다"가 아니다.

### F-12 판정 불가 항목

- **Acceptance 1 (전 서비스 기동 후 `/health` 200)**: **판정 불가.** Atlas 자격증명
  (`MONGODB_URI`)과 `ANTHROPIC_API_KEY`·`VOYAGE_API_KEY`가 없어 스택을 끝까지 띄우지 못했다.
  상태가 전부 Atlas라(specs/06) 로컬 대체물이 없다. 확인한 데까지만 적는다:
  - 이미지 5종 **전부 빌드 성공**
  - `mcp` 이미지가 실제로 뜨고 `mcp.listening`을 낸다
  - `core-api` 이미지가 env 없이 **부팅을 거부한다**(fail-fast가 컨테이너에서도 보존됨)
  - `web` 이미지가 뜨고 `/`가 **HTTP 200**
  - `docker compose config`가 base·prod 오버레이 모두 해소된다
  - nginx가 `/health`를 core-api 업스트림으로 넘긴다(설정·라우팅 검증)
  → **남은 것은 Atlas가 붙은 환경에서의 실제 기동 1회다.**
- **F-5 캐시 효과**: CI에서만 측정 가능.
