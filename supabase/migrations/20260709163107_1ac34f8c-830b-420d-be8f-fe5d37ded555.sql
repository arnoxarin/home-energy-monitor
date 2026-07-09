CREATE TABLE public.device_pair_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  claimed_at TIMESTAMPTZ,
  claimed_device_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX device_pair_codes_active_code_idx
  ON public.device_pair_codes(code)
  WHERE claimed_at IS NULL;

CREATE INDEX device_pair_codes_user_id_idx ON public.device_pair_codes(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_pair_codes TO authenticated;
GRANT ALL ON public.device_pair_codes TO service_role;

ALTER TABLE public.device_pair_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own pair codes"
  ON public.device_pair_codes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
