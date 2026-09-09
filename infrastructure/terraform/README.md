# Staging Infrastructure — Terraform

This directory contains the Infrastructure as Code (IaC) configuration for the
future AiConnect staging environment.

The infrastructure is currently **not provisioned**. This directory is being
prepared for future staging implementation.

## Planned Staging Components

The staging environment will eventually provide:

- Web runtime
- API runtime
- Worker runtime
- PostgreSQL 16
- Redis
- Private object storage
- Secrets and configuration management
- Networking
- HTTPS and public routing
- Logging and health monitoring

## Terraform File Structure

| File | Purpose |
|---|---|
| `providers.tf` | Terraform and AWS provider configuration |
| `variables.tf` | Configurable infrastructure values |
| `outputs.tf` | Useful infrastructure outputs |
| `networking.tf` | VPC/networking, subnets, routing, and security boundaries |
| `compute.tf` | Web, API, and Worker runtimes |
| `database.tf` | PostgreSQL 16 staging database |
| `redis.tf` | Redis staging infrastructure |
| `storage.tf` | Private staging object storage |
| `secrets.tf` | Staging secrets and configuration |

## Planned Architecture

```text
                    Staging Environment
                           |
             +-------------+-------------+
             |             |             |
             v             v             v
           Web            API          Worker
                           |              |
                    +------+-------+      |
                    |              |      |
                    v              v      v
              PostgreSQL 16      Redis <---+
                    |
                    v
             Private Storage

              Secrets / Configuration
                       |
             +---------+---------+
             |         |         |
             v         v         v
            Web        API      Worker

              Logging / Monitoring
                       |
                 API + Worker
