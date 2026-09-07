import { loadConfig } from './configuration';
import { assertDevelopmentSeedAllowed } from '../../prisma/seed-guard';

describe('development seed guard', () => {
  it('refuses to run in production', () => {
    expect(() => assertDevelopmentSeedAllowed('production')).toThrow(
      'Development seed cannot run in production',
    );
  });
});

describe('production configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      APP_ROLE: 'api',
      QUEUE_DRIVER: 'bullmq',
      REDIS_URL: 'redis://localhost:6379',
      CORS_ORIGINS: 'https://portal.example.com',
      JWT_SECRET: 'production-test-secret-that-is-long-enough-123',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects inline queues in production', () => {
    process.env.QUEUE_DRIVER = 'inline';

    expect(() => loadConfig()).toThrow('QUEUE_DRIVER=inline is not allowed in production');
  });

  it('rejects both-role production processes', () => {
    process.env.APP_ROLE = 'both';

    expect(() => loadConfig()).toThrow('APP_ROLE=both is not allowed in production');
  });

  it('requires a valid Redis URL for BullMQ', () => {
    delete process.env.REDIS_URL;

    expect(() => loadConfig()).toThrow('Missing required environment variable: REDIS_URL');
  });

  it('rejects malformed Redis URLs for BullMQ', () => {
    process.env.REDIS_URL = 'https://redis.example.com';

    expect(() => loadConfig()).toThrow('REDIS_URL must be a valid redis:// or rediss:// URL');
  });

  it('rejects wildcard CORS with credentials', () => {
    process.env.CORS_ORIGINS = '*';

    expect(() => loadConfig()).toThrow('CORS_ORIGINS cannot contain *');
  });

  it('rejects missing CORS origins', () => {
    process.env.CORS_ORIGINS = '';

    expect(() => loadConfig()).toThrow('CORS_ORIGINS must contain at least one explicit origin');
  });

  it('requires live storage credentials at boot without exposing their values', () => {
    process.env.STORAGE_MODE = 'live';
    process.env.S3_BUCKET = 'private-bucket';
    process.env.AWS_REGION = 'ap-south-1';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    expect(() => loadConfig()).toThrow(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required when STORAGE_MODE=live',
    );
  });

  it('requires an explicit bucket for live storage', () => {
    process.env.STORAGE_MODE = 'live';
    delete process.env.S3_BUCKET;

    expect(() => loadConfig()).toThrow('Missing required environment variable: S3_BUCKET');
  });

  it('rejects an excessive signed URL lifetime', () => {
    process.env.STORAGE_SIGNED_URL_MAX_EXPIRY_SECONDS = '3601';

    expect(() => loadConfig()).toThrow('STORAGE_SIGNED_URL_MAX_EXPIRY_SECONDS must be between 1 and 3600');
  });

  it('requires an expected SNS topic for a live production email provider', () => {
    process.env.EMAIL_MODE = 'live';
    delete process.env.SES_SNS_TOPIC_ARNS;

    expect(() => loadConfig()).toThrow(
      'SES_SNS_TOPIC_ARNS must contain at least one expected topic when EMAIL_MODE=live',
    );
  });

  it('rejects malformed SNS topic configuration without echoing its value', () => {
    process.env.SES_SNS_TOPIC_ARNS = 'https://attacker.example.test/topic';

    expect(() => loadConfig()).toThrow('SES_SNS_TOPIC_ARNS contains an invalid SNS topic ARN');
  });

  it('requires explicit region and credentials for live SES SMTP', () => {
    process.env.EMAIL_MODE = 'live';
    process.env.EMAIL_TRANSPORT = 'ses';
    process.env.SES_SNS_TOPIC_ARNS = 'arn:aws:sns:ap-south-1:123456789012:ses-events';
    delete process.env.AWS_SES_REGION;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    expect(() => loadConfig()).toThrow('Missing required environment variable: AWS_SES_REGION');

    process.env.AWS_SES_REGION = 'ap-south-1';
    expect(() => loadConfig()).toThrow('SMTP_USER and SMTP_PASS are required for live SES SMTP transport');
  });
});
