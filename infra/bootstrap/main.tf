# ---------------------------------------------------------------------------
# 백엔드 부트스트랩. 이 루트만 **로컬 state** 를 쓴다.
#
# 왜 별도 루트인가: infra/ 의 상태를 담을 S3 버킷을 infra/ 자신이 만들 수 없다.
# 상태를 저장할 곳이 아직 없기 때문이다(닭-달걀). 세 선택지 중:
#   (a) 콘솔에서 손으로 만든다        → 설정이 코드에 안 남는다
#   (b) infra/ 가 만들고 나중에 migrate → 첫 apply 가 2단계라 재현이 어렵다
#   (c) 로컬 state 를 쓰는 별도 루트   ← 채택
# (c) 를 고른 이유: 만드는 리소스가 버킷·테이블 둘뿐이고 둘 다 이름이 결정적이라,
# state 를 잃어도 `terraform import` 두 줄로 복구된다. 그 대가로 얻는 게
# "백엔드 구성도 코드에 남는다" 이다.
#
# 실행(1회):
#   cd infra/bootstrap && terraform init && terraform apply
#   → output state_bucket_name 을 infra/backend.hcl 에 적는다
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

locals {
  # 전역 고유해야 하므로 계정 ID 를 붙인다.
  bucket_name = "${var.project}-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name

  # 상태 파일 유실은 복구가 아주 비싸다. 실수 destroy 를 막는다.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 백엔드의 상태 락(T-025 Acceptance 3).
resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
