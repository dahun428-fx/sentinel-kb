data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name_prefix}-app"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# SSM Session Manager 접속·RunCommand 배포의 근거. SSH 키를 안 쓰는 대가로 이게 필수다.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  # ECR: compose pull.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPull"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  # 시크릿 읽기: 이 프로젝트/환경 경로 아래로만.
  statement {
    sid    = "SsmReadOwnParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*",
    ]
  }

  # SecureString 복호화. AWS 관리 키(alias/aws/ssm)로 제한.
  statement {
    sid       = "KmsDecryptSsm"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  # -------------------------------------------------------------------------
  # Route53 DNS-01 (T-026 F-2 해소).
  #
  # certbot 이 `_acme-challenge` TXT 를 심어 도메인 소유권을 증명한다. HTTP-01 은 쓸 수
  # 없다 — SG 가 80 을 열지 않기 때문이다(specs/06 네트워크 행, docker/README.md 결정 1).
  # **이 권한이 없으면 `certbot-init` 이 AccessDenied 로 실패하고, 인증서가 없으면
  # nginx prod 블록이 뜨지 않아 배포가 완결되지 않는다.**
  #
  # 인스턴스 롤로 인증하므로 정적 키가 없다(ec2.tf 의 hop_limit = 2 가 컨테이너 IMDS 를
  # 이미 열어 두었다).
  # -------------------------------------------------------------------------
  statement {
    sid    = "Route53ListZones"
    effect = "Allow"
    # 이 액션은 리소스 수준 제한을 지원하지 않는다(존을 찾으려면 목록을 봐야 한다).
    # 존 이름·ID 는 어차피 공개 정보라 노출 위험이 없고, 쓰기는 아래에서 좁힌다.
    actions   = ["route53:ListHostedZones"]
    resources = ["*"]
  }

  statement {
    sid       = "Route53PollChange"
    effect    = "Allow"
    actions   = ["route53:GetChange"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::change/*"]
  }

  statement {
    sid       = "Route53ReadOwnZone"
    effect    = "Allow"
    actions   = ["route53:ListResourceRecordSets"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::hostedzone/${data.aws_route53_zone.this.zone_id}"]
  }

  # 쓰기는 **ACME 챌린지 레코드 하나로** 좁힌다. 이 조건이 없으면 앱 호스트가 탈취당했을 때
  # 존의 A 레코드를 다른 IP 로 갈아끼울 수 있다 — 도메인 전체를 넘겨주는 것과 같다.
  #
  # 조건 키가 다치(multi-value)라 `ForAllValues:` 가 필요하다. 두 키 모두
  # ChangeResourceRecordSets 에만 적용되므로 위의 읽기 문장과 합치면 안 된다
  # (조건을 만족시킬 수 없어 읽기가 통째로 막힌다).
  #
  # 와일드카드 인증서(`*.example.com`)도 챌린지 이름은 같아서 그대로 발급된다.
  # 이 정책을 풀어야 하는 상황이 오면 조건 블록만 지우면 되고, 그때는
  # `tools/deploy-contract.spec.ts` 가 근거를 요구한다.
  statement {
    sid       = "Route53AcmeChallengeWriteOnly"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::hostedzone/${data.aws_route53_zone.this.zone_id}"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["_acme-challenge.${lower(var.domain_name)}"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }
  }

  # awslogs 드라이버(specs/06 관측 행).
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "${aws_cloudwatch_log_group.app.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name_prefix}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name_prefix}-app"
  role = aws_iam_role.app.name
}
