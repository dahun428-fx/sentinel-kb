# 06 — AWS 배포

| 항목 | 선택 |
|---|---|
| 컴퓨트 | EC2 t3.small 1대 + Docker Compose (nginx / core-api / mcp / worker / web) |
| TLS | Route53 + nginx + Let's Encrypt(certbot, 자동 갱신 cron) |
| 네트워크 | SG 443만 인바운드. **SSH 포트 미개방**, 접속은 SSM Session Manager |
| 상태 | 전부 Atlas. EC2는 언제든 재생성 가능(NFR-07) |
| 레지스트리 | ECR |
| CI/CD | GH Actions: verify → 이미지 빌드 → ECR push → SSM RunCommand로 `compose pull && up -d` |
| 시크릿 | SSM Parameter Store(SecureString) → 배포 시 .env 렌더 |
| 관측 | CloudWatch Logs(awslogs 드라이버) + `/health` 모니터, LLM 호출별 토큰·지연 구조화 로깅(pino) |
| 백업 | Atlas 자동 백업 + 주간 mongodump → S3 (라이프사이클 30일) |
| IaC | Terraform 최소셋: VPC/SG/EC2/Route53/ECR/IAM. 그 이상 모듈화 안 함 |

## nginx 라우팅
```
/mcp   → mcp:3002    (Streamable HTTP, proxy_buffering off, read_timeout 300s)
/v1    → core-api:3001
/      → web:3000
```
MCP·SSE 경로는 버퍼링을 끄지 않으면 스트리밍이 죽는다. **배포 후 첫 검증 항목.**

## 런북
- 배포 롤백: 직전 이미지 태그로 `compose up -d`
- 워커 적체: `jobs` status 집계 확인 → dead job 재큐잉 스크립트
- 인증서 갱신 실패: certbot 로그 → 수동 `certbot renew --force-renewal`
- 재해 복구: 새 EC2 기동 → user-data가 compose pull → DNS 스왑 (데이터 무이동)
