# T-025: Terraform 최소셋
refs: specs/06-deployment.md
M: M6 | deps: -

## Scope
- `infra/`: VPC(기본 사용 가능 시 생략), SG(443만), EC2(t3.small, SSM 역할), ECR, Route53 레코드, IAM
- SSM Parameter Store 파라미터 정의(값은 수동 주입)
- `terraform plan`이 CI에서 검증되도록 워크플로 추가

## Out of scope
- 애플리케이션 배포(T-027)

## Acceptance
- [ ] `terraform validate` + `plan` 성공(CI)
- [ ] SG에 22번 포트 인바운드 규칙이 없음을 검증하는 정책 테스트(tfsec 또는 grep)
- [ ] 상태 파일은 S3 백엔드 + DynamoDB 락으로 구성
- [ ] `pnpm verify` 그린

## Context budget
- 읽기: specs/06, infra/**
