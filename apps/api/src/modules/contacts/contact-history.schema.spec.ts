import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Contact history database constraints', () => {
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../../prisma/migrations/20260906000000_contact_soft_delete_and_history_protection/migration.sql',
    ),
    'utf8',
  );

  it.each([
    ['Call', 'calls_contact_id_fkey'],
    ['CommunicationEvent', 'communication_events_contact_id_fkey'],
    ['CampaignRecipient', 'campaign_recipients_contact_id_fkey'],
  ])('preserves %s rows by restricting physical Contact deletion', (_model, constraint) => {
    expect(migration).toMatch(new RegExp(`${constraint}[^;]+ON DELETE RESTRICT`, 's'));
  });

  it('preserves CallTranscriptTurn through the protected Call relation', () => {
    expect(schema).toMatch(/model CallTranscriptTurn \{[\s\S]+?call\s+Call\s+@relation\([^\n]+onDelete: Cascade\)/);
    expect(schema).toMatch(/model Call \{[\s\S]+?contact\s+Contact\s+@relation\([^\n]+onDelete: Restrict\)/);
  });

  it('keeps nullable UsageEvent history on SetNull', () => {
    expect(schema).toMatch(/model UsageEvent \{[\s\S]+?contact\s+Contact\?\s+@relation\([^\n]+onDelete: SetNull\)/);
  });
});
