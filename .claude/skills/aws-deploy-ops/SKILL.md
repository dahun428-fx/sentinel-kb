---
name: aws-deploy-ops
description: AWS EC2 + Docker Compose 배포, nginx 설정, Terraform, CI/CD 파이프라인, 배포 롤백이나 장애 대응을 할 때 반드시 사용한다. SSE/MCP 스트리밍을 위한 nginx 설정, SSM 기반 무SSH 운영, 시크릿 관리, 런북을 다룬다. 배포·인프라·nginx·롤백 관련 작업이면 이 스킬을 먼저 읽는다.
---

# AWS Deploy Ops

## 구성
EC2 1대 + Docker Compose (nginx / core-api / mcp / worker / web) + Atlas.
서버는 stateless — 상태는 전부 Atlas에 있다. EC2는 언제든 버리고 다시 만든다.

## nginx — 가장 자주 터지는 곳
```nginx
location /mcp {
  proxy_pass http://mcp:3002;
  proxy_buffering off;          # 없으면 스트리밍이 죽는다
  proxy_read_timeout 300s;
  proxy_set_header Connection '';
  proxy_http_version 1.1;
}
location /v1 { proxy_pass http://core-api:3001; proxy_buffering off; }
location /   { proxy_pass http://web:3000; }
```
**`proxy_buffering off`를 빼면 SSE와 MCP 스트리밍이 조용히 멈춘다.**
배포 후 첫 검증 항목이 이것이다: 스트리밍이 청크 단위로 도착하는가.

## 보안
- SG 인바운드는 443만. **22번을 열지 않는다** — 접속은 SSM Session Manager
- 시크릿은 SSM Parameter Store(SecureString) → 배포 시 .env 렌더
- CI는 OIDC로 AWS 인증. 장기 액세스 키를 GitHub에 넣지 않는다

## 배포
`verify → build → ECR push(sha 태그) → SSM RunCommand → compose pull && up -d → 스모크`
스모크: `/health` 200 + MCP 도구 목록 5개. 실패 시 직전 태그로 자동 롤백.

## 런북
| 증상 | 조치 |
|---|---|
| 배포 후 스트리밍 멈춤 | nginx proxy_buffering 확인 |
| 워커 적체 | `jobs` status 집계 → dead job 재큐잉 |
| 인증서 만료 | certbot 로그 → `certbot renew --force-renewal` |
| 인스턴스 사망 | 새 EC2 기동(user-data가 compose pull) → DNS 스왑. 데이터 이동 없음 |
| MCP 401 | 키의 project 클레임 확인, SSM 파라미터 최신인지 확인 |

## 하지 않는 것
ECS/EKS/블루그린. 현 규모에서 과설계다. **이 판단 자체를 README에 근거와 함께 남긴다.**
