-- Sync History diagnostics: what the provider actually answered, and how far a run got.

ALTER TABLE sync_jobs ADD COLUMN api_status INTEGER;
ALTER TABLE sync_jobs ADD COLUMN error_code TEXT;
ALTER TABLE sync_jobs ADD COLUMN error_reason TEXT;
ALTER TABLE sync_jobs ADD COLUMN error_endpoint TEXT;
ALTER TABLE sync_jobs ADD COLUMN provider_message TEXT;
ALTER TABLE sync_jobs ADD COLUMN listed INTEGER;
ALTER TABLE sync_jobs ADD COLUMN attempted INTEGER;
ALTER TABLE sync_jobs ADD COLUMN fetched INTEGER;
ALTER TABLE sync_jobs ADD COLUMN api_calls INTEGER;
ALTER TABLE sync_jobs ADD COLUMN rate_limit_waits INTEGER;
