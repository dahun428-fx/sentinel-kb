output "state_bucket_name" {
  description = "infra/backend.hcl 의 bucket 값."
  value       = aws_s3_bucket.state.id
}

output "lock_table_name" {
  description = "infra/backend.tf 의 dynamodb_table 값과 일치해야 한다."
  value       = aws_dynamodb_table.lock.name
}
