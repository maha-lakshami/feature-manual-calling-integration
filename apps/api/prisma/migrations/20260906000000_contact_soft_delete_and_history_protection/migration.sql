-- AlterTable
ALTER TABLE "contacts" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Historical rows retain their required Contact reference. Soft deletion is the normal
-- path; RESTRICT is the database backstop against accidental physical deletion.
ALTER TABLE "campaign_recipients" DROP CONSTRAINT "campaign_recipients_contact_id_fkey";
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "calls" DROP CONSTRAINT "calls_contact_id_fkey";
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "communication_events" DROP CONSTRAINT "communication_events_contact_id_fkey";
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
