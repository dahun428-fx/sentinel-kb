variable "project" {
  type    = string
  default = "sentinel-kb"
}

variable "aws_region" {
  description = "infra/backend.tf 의 region 과 반드시 같아야 한다."
  type        = string
  default     = "ap-northeast-2"
}

variable "lock_table_name" {
  description = "infra/backend.tf 의 dynamodb_table 과 반드시 같아야 한다."
  type        = string
  default     = "sentinel-kb-tfstate-lock"
}
