-- Per-workflow execution-completion webhook.
ALTER TABLE workflows ADD COLUMN completion_webhook_url TEXT;
ALTER TABLE workflows ADD COLUMN completion_webhook_secret_encrypted BYTEA;
