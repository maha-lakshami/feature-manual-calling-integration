# Terraform Infrastructure

Infrastructure as Code (IaC) for the future AiConnect staging environment.

## Planned Infrastructure

- AWS VPC and networking
- Web, API and Worker runtimes
- PostgreSQL 16
- Redis
- Private object storage
- Secrets and configuration
- HTTPS and public routing
- Logging and monitoring

## Structure

- `providers.tf` — Terraform and AWS provider configuration
- `variables.tf` — Configurable infrastructure values
- `outputs.tf` — Infrastructure outputs
- `networking.tf` — VPC, subnets and routing
- `compute.tf` — Web, API and Worker
- `database.tf` — PostgreSQL
- `redis.tf` — Redis
- `storage.tf` — Private storage
- `secrets.tf` — Secrets and configuration

## Status

**Prepared for future implementation.**

No cloud infrastructure is currently provisioned through this directory.

Actual staging infrastructure will be implemented and provisioned later.
