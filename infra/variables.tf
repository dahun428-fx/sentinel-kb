variable "project" {
  description = "리소스 이름 접두사."
  type        = string
  default     = "sentinel-kb"
}

variable "environment" {
  description = "환경 이름. 리소스 이름과 SSM 파라미터 경로에 들어간다."
  type        = string
  default     = "prod"
}

variable "aws_region" {
  description = "리소스를 만들 리전. backend.tf 의 region 과 별개다(백엔드는 리터럴 고정)."
  type        = string
  default     = "ap-northeast-2"
}

variable "instance_type" {
  description = "앱 호스트 인스턴스 타입. specs/06 은 t3.small 1대에 컨테이너 5개."
  type        = string
  default     = "t3.small"
}

variable "root_volume_size_gb" {
  description = "루트 EBS 크기(GiB). 이미지 5개 + 로그 여유."
  type        = number
  default     = 30
}

variable "vpc_id" {
  description = "사용할 VPC. null 이면 계정 기본 VPC를 쓴다(specs/06: VPC는 기본 사용 시 생략)."
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "앱 호스트를 둘 퍼블릭 서브넷. null 이면 VPC의 첫 서브넷을 고른다."
  type        = string
  default     = null
}

variable "allowed_https_cidrs" {
  description = <<-EOT
    443 인바운드를 허용할 CIDR. 여기 외의 인바운드 규칙은 만들지 않는다.
    22(SSH)는 어떤 값으로도 열 수 없다 — 접속은 SSM Session Manager 다(specs/06).
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "route53_zone_name" {
  description = "기존 Route53 퍼블릭 호스티드 존 이름. 예: example.com"
  type        = string
}

variable "domain_name" {
  description = "앱 호스트에 붙일 FQDN. 예: kb.example.com"
  type        = string
}

variable "ecr_repositories" {
  description = "만들 ECR 리포지토리 목록. specs/06 의 compose 서비스와 1:1."
  type        = list(string)
  default     = ["nginx", "core-api", "mcp", "worker", "web"]
}

variable "secure_parameter_names" {
  description = <<-EOT
    SSM Parameter Store 에 **정의만** 할 SecureString 파라미터 이름.
    값은 terraform 이 관리하지 않는다 — 배포 담당자가 콘솔/CLI로 수동 주입한다.
    (CLAUDE.md 금지사항: 시크릿 하드코딩)

    이 목록은 `infra/deploy/deploy.sh` 가 .env 로 렌더하는 목록과 **글자 그대로 같아야
    한다.** 하나라도 어긋나면 배포는 성공하는데 compose 가 `:?` 로 거절하거나, 반대로
    파라미터만 만들어지고 아무도 읽지 않는다. `tools/deploy-contract.spec.ts` 가 대조한다.

    `CORE_API_KEY` 는 T-027 에서 추가됐다 — T-026 의 compose 가 web 서비스에
    `CORE_API_KEY:?` 로 요구하는데 T-025 의 이 목록에 없어서, 그대로면 첫 배포가
    `up -d` 단계에서 죽는다(T-027 F-4). 값은 `API_KEYS` 에 등록된 키 중 하나여야 한다.
  EOT
  type        = list(string)
  default = [
    "MONGODB_URI",
    "ANTHROPIC_API_KEY",
    "VOYAGE_API_KEY",
    "API_KEYS",
    "CORE_API_KEY",
  ]
}

variable "log_retention_days" {
  description = "CloudWatch Logs 보존 기간."
  type        = number
  default     = 30
}
