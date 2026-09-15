# 06 — AWS 배포

| 항목 | 선택 |
|---|---|
| 컴퓨트 | EC2 t3.small 1대 + Docker Compose (nginx / core-api / mcp / worker / web) |
| TLS | Route53 + nginx + Let's Encrypt(certbot, 자동 갱신 cron) |
| 네트워크 | SG 443만 인바운드. **SSH 포트 미개방**, 접속은 SSM Session Manager |
| 상태 | 전부 Atlas. EC2는 언제든 재생성 가능(NFR-07) |
| 레지스트리 | ECR |
| CI/CD | GH Actions: verify → 이미지 빌드 → ECR push → SSM RunCommand로 `compose pull && up -d` |
| 시크릿 | SSM Parameter Store(SecureString) → 배포 시 .env + nginx htpasswd 렌더 (T-042) |
| 관측 | CloudWatch Logs(awslogs 드라이버) + `/health` 모니터, LLM 호출별 토큰·지연 구조화 로깅(pino) |
| 백업 | Atlas 자동 백업 + 주간 mongodump → S3 (라이프사이클 30일) |
| IaC | Terraform 최소셋: VPC/SG/EC2/Route53/ECR/IAM. 그 이상 모듈화 안 함 |

## nginx 라우팅
```
경로     대상               비고                                              인증
/mcp   → mcp:3002    (Streamable HTTP, proxy_buffering off, read_timeout 300s) 앱 계층 Bearer (MCP → core-api 전달)
/v1    → core-api:3001                                                         앱 계층 Bearer (core-api)
/      → web:3000    (/records·/articles 등 자기 location이 없는 전 경로)       nginx basic (T-042)
```
`/health`(→ core-api:3001)는 위 표에 없는 초과분이고 **인증 면제**다. 모니터와 compose
헬스체크가 자격증명 없이 두드려야 하기 때문이다(관측 행). 표에 넣는 문면 정정은
인간 비준 대기 중이다(T-026 F-1).

MCP·SSE 경로는 버퍼링을 끄지 않으면 스트리밍이 죽는다. **배포 후 첫 검증 항목.**

## web 표면 인증 (T-042)

`/`는 nginx HTTP Basic 인증 뒤에 있다. 자격증명 파일은 이미지에 굽지 않고 런타임에
`/etc/nginx/secrets/htpasswd`로 마운트하며, 호스트 경로는 `WEB_BASIC_AUTH_FILE`이 준다.
프로덕션에서는 시크릿 행과 같은 경로를 탄다 — SSM Parameter Store(SecureString) → 배포 시 렌더.
미설정이면 `docker compose`가 해소 단계에서 거절한다(web을 열어 둔 채 뜨지 않는다).

### 이 방식이 NFR-04를 **부분만** 충족한다

specs/00 NFR-04는 "모든 외부 표면 Bearer 인증, **프로젝트별 키**"다. basic 인증은
앞 절반만 준다.

| NFR-04 요구 | HTTP(`/v1`)·MCP(`/mcp`) | web(`/`) |
|---|---|---|
| 외부 표면 인증 | 충족 (T-007, T-014) | 충족 (T-042) |
| **프로젝트별 키 구분** | 충족 (`API_KEYS`의 `<key>:<projectSlug>`) | **미충족** |

- **basic 인증은 프로젝트를 구분하지 못한다.** 자격증명 하나가 web 전체를 열고, web은
  서버 사이드 단일 키(`CORE_API_KEY`) 하나로 core-api를 부른다. 즉 "누가 들어왔는가"가
  core-api까지 전달되지 않는다.
- 그래서 **감사 B-2(아티클 `project` 스코프 부재)는 이 조치로 닫히지 않는다.** basic
  인증을 통과한 사용자는 여전히 남의 project 아티클을 편집·발행할 수 있다
  (`packages/web/src/app/articles/actions.ts`). specs/08 §7의 "사람 승인"은 승인자가
  **누구인지**까지는 여전히 강제하지 않는다.
- 닫으려면 web에 호출자 신원 개념(세션·프로젝트별 키)이 필요하다. **별도 태스크이며
  비준 대기 항목이다.** 그때까지 이 문면이 남은 노출의 정본이다.

## 런북
- 배포 롤백: 직전 이미지 태그로 `compose up -d`
- 워커 적체: `jobs` status 집계 확인 → dead job 재큐잉 스크립트
- 인증서 갱신 실패: certbot 로그 → 수동 `certbot renew --force-renewal`
- web 자격증명 교체(T-042): SSM 값 갱신 → htpasswd 재렌더 → `compose exec nginx nginx -s reload`
  (파일만 갈아끼우면 되고 재배포는 필요 없다. `/`가 500이면 마운트가 빠진 것이다 — 열린 게 아니라 닫힌 상태다)
- 재해 복구: 새 EC2 기동 → user-data가 compose pull → DNS 스왑 (데이터 무이동)
