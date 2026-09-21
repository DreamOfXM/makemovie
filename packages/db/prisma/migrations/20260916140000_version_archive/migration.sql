-- Version hygiene: drafts can be deleted, approved versions can be archived (and
-- unarchived). archivedAt marks the soft-hide without touching workflow status.
ALTER TABLE "ScriptVersion" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "SourceDocumentVersion" ADD COLUMN "archivedAt" TIMESTAMP(3);
