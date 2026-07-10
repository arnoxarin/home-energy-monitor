
-- Wipe old schema
DROP TABLE IF EXISTS public.device_pair_codes CASCADE;
DROP TABLE IF EXISTS public.ingest_attempts CASCADE;
DROP TABLE IF EXISTS public.sensor_readings CASCADE;
DROP TABLE IF EXISTS public.sensors CASCADE;
DROP TABLE IF EXISTS public.devices CASCADE;

-- Devices
CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mac text UNIQUE NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
  device_token text UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  fw_version text,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated;
GRANT ALL ON public.devices TO service_role;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read own or pending unassigned" ON public.devices
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR (status = 'pending' AND user_id IS NULL));

CREATE POLICY "update own" ON public.devices
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "claim pending" ON public.devices
  FOR UPDATE TO authenticated
  USING (status = 'pending' AND user_id IS NULL)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "delete own" ON public.devices
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Sensors
CREATE TABLE public.sensors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind public.sensor_kind NOT NULL,
  pin text,
  view public.sensor_view NOT NULL DEFAULT 'graph',
  unit text,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sensors TO authenticated;
GRANT ALL ON public.sensors TO service_role;
ALTER TABLE public.sensors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sensors" ON public.sensors FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_enforce_unique_sensor_pins
  BEFORE INSERT OR UPDATE ON public.sensors
  FOR EACH ROW EXECUTE FUNCTION public.enforce_unique_sensor_pins();

-- Readings
CREATE TABLE public.sensor_readings (
  id bigserial PRIMARY KEY,
  sensor_id uuid NOT NULL REFERENCES public.sensors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sensor_readings_sensor_ts_idx ON public.sensor_readings (sensor_id, ts DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sensor_readings TO authenticated;
GRANT ALL ON public.sensor_readings TO service_role;
ALTER TABLE public.sensor_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own readings" ON public.sensor_readings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
