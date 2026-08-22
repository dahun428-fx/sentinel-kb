data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"

  # SSM 파라미터 경로 접두사. IAM 정책도 이 경로로만 읽기를 허용한다.
  ssm_prefix = "/${var.project}/${var.environment}"

  log_group_name = "/${var.project}/${var.environment}/app"
}
