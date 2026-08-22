data "aws_vpc" "this" {
  id = var.vpc_id
  # var.vpc_id 가 null 일 때만 "기본 VPC" 조건으로 조회한다.
  default = var.vpc_id == null ? true : null
}

data "aws_subnets" "this" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }
}

locals {
  subnet_id = coalesce(var.subnet_id, sort(data.aws_subnets.this.ids)[0])
}

# ---------------------------------------------------------------------------
# 앱 호스트 SG
#
# 인바운드는 443 뿐이다. SSH(22) 인바운드 규칙은 존재하지 않으며 존재해서도 안 된다 —
# 호스트 접속은 SSM Session Manager 를 쓴다(specs/06 네트워크 행).
# 이 불변식은 infra/policy/no-ssh-ingress.sh 가 CI 에서 기계 검증한다.
# ---------------------------------------------------------------------------
resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app"
  description = "sentinel-kb app host: HTTPS inbound only, shell access via SSM Session Manager"
  vpc_id      = data.aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-app"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.allowed_https_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "HTTPS (nginx TLS terminator)"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

  tags = {
    Name = "${local.name_prefix}-https"
  }
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  description       = "all egress: ECR pull, Atlas, SSM, LLM/embedding APIs, ACME"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"

  tags = {
    Name = "${local.name_prefix}-egress"
  }
}
