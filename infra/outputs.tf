output "instance_id" {
  description = "SSM Session Manager / RunCommand 대상 ID."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "앱 호스트 EIP."
  value       = aws_eip.app.public_ip
}

output "fqdn" {
  description = "Route53 A 레코드."
  value       = aws_route53_record.app.fqdn
}

output "security_group_id" {
  value = aws_security_group.app.id
}

output "ecr_repository_urls" {
  description = "compose 서비스별 ECR 리포지토리 URL."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "ssm_parameter_prefix" {
  description = "배포 시 .env 를 렌더할 파라미터 경로 접두사."
  value       = local.ssm_prefix
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}
