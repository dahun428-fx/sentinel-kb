resource "aws_ecr_repository" "this" {
  for_each = toset(var.ecr_repositories)

  # ⚠️ 구분자는 `-` 다. `/` 가 아니다.
  #
  # `docker-compose.prod.yml` 이 `${ECR_REGISTRY}/sentinel-kb-core-api:${IMAGE_TAG}` 로
  # 당긴다. 여기가 `sentinel-kb/core-api` 면 리포지토리가 만들어져도 **compose 의 pull 이
  # 404 로 죽는다** — 그것도 terraform apply 나 이미지 푸시가 아니라 배포 마지막 단계에서.
  # compose 는 T-026 이 정본이고 여기가 맞춘다. 두 이름은
  # `tools/deploy-contract.spec.ts` 가 기계로 묶어 둔다 (T-027 F-3).
  name                 = "${var.project}-${each.value}"
  image_tag_mutability = "MUTABLE" # 롤백 런북이 직전 태그를 다시 가리킨다(specs/06)

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = "${var.project}-${each.value}"
  }
}

# 롤백을 위해 최근 이미지는 남기되 무한 증식은 막는다.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "keep last 20 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
