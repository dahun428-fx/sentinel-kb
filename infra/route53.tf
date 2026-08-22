data "aws_route53_zone" "this" {
  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 60 # 재해 복구 시 DNS 스왑이 빨라야 한다(specs/06 런북)
  records = [aws_eip.app.public_ip]
}
