UPDATE "projects" SET "permission" = 'auto' WHERE "permission" <> 'auto';
ALTER TABLE "projects" ALTER COLUMN "permission" SET DEFAULT 'auto';
