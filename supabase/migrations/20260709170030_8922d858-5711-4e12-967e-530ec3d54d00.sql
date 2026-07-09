
CREATE TABLE public.ingest_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  endpoint text NOT NULL,
  key_masked text NOT NULL,
  key_len int NOT NULL,
  matched boolean NOT NULL,
  device_id uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  user_id uuid,
  fw_version text,
  fw_build text,
  ip text,
  status int
);

CREATE INDEX ingest_attempts_user_ts_idx ON public.ingest_attempts (user_id, ts DESC);
CREATE INDEX ingest_attempts_device_ts_idx ON public.ingest_attempts (device_id, ts DESC);

GRANT SELECT ON public.ingest_attempts TO authenticated;
GRANT ALL ON public.ingest_attempts TO service_role;

ALTER TABLE public.ingest_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own ingest attempts"
  ON public.ingest_attempts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
