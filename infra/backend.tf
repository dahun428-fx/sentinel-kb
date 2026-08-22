# 상태 파일: S3 백엔드 + DynamoDB 락 (T-025 Acceptance 3).
#
# bucket 만 부분 설정(-backend-config)으로 주입한다. S3 버킷 이름은 전역 고유라
# 계정마다 달라지고, 레포에 박으면 다른 계정에서 그대로 쓸 수 없기 때문이다.
#
#   terraform init -backend-config=backend.hcl
#
# 나머지(key/region/encrypt/dynamodb_table)는 환경에 무관한 규약이라 여기에 고정한다.
# 이 버킷과 테이블 자체는 infra/bootstrap 이 만든다 — 닭-달걀 문제. infra/README.md 참조.
terraform {
  backend "s3" {
    key            = "sentinel-kb/prod/terraform.tfstate"
    region         = "ap-northeast-2"
    encrypt        = true
    dynamodb_table = "sentinel-kb-tfstate-lock"
  }
}
