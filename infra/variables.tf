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
  EOT
  type        = list(string)
  default     = ["MONGODB_URI", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "API_KEYS"]
}

variable "log_retention_days" {
  description = "CloudWatch Logs 보존 기간."
  type        = number
  default     = 30
}
