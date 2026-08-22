# ---------------------------------------------------------------------------
# SSM Parameter Store: 파라미터를 **정의만** 한다. 값은 수동 주입이다.
#
# terraform 은 aws_ssm_parameter 에 value 를 요구하므로 시크릿이 아닌 sentinel 문자열을
# 넣고 lifecycle.ignore_changes 로 이후 변경을 무시한다. 실제 값을 tfvars/코드에 넣으면
# 평문이 state 와 git 에 남는다 — CLAUDE.md 금지사항(시크릿 하드코딩).
#
# 주입:
#   aws ssm put-parameter --name /sentinel-kb/prod/MONGODB_URI \
#     --type SecureString --value "<실제값>" --overwrite
# ---------------------------------------------------------------------------
locals {
  # 값이 주입되지 않은 파라미터를 배포 스크립트가 식별할 수 있게 하는 표식.
  # 시크릿이 아니다.
  unset_parameter_sentinel = "__SET_ME_VIA_AWS_CLI__"
}

resource "aws_ssm_parameter" "secure" {
  for_each = toset(var.secure_parameter_names)

  name        = "${local.ssm_prefix}/${each.value}"
  description = "sentinel-kb ${var.environment} ${each.value} (값은 수동 주입, T-025)"
  type        = "SecureString"
  value       = local.unset_parameter_sentinel

  tags = {
    Name = "${local.ssm_prefix}/${each.value}"
  }

  lifecycle {
    # 값은 terraform 밖에서 관리한다. 이게 없으면 apply 마다 실제 시크릿을
    # sentinel 로 덮어써서 서비스를 죽인다.
    ignore_changes = [value]
  }
}
