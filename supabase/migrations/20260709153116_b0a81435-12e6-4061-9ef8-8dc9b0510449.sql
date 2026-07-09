ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS fw_version text,
  ADD COLUMN IF NOT EXISTS fw_build text,
  ADD COLUMN IF NOT EXISTS fw_reported_at timestamptz;