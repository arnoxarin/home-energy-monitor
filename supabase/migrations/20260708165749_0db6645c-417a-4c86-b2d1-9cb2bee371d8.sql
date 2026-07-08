
CREATE OR REPLACE FUNCTION public.enforce_unique_sensor_pins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_pins TEXT[];
  conflict_pin TEXT;
  conflict_sensor_name TEXT;
BEGIN
  -- Collect all pins claimed by NEW (primary pin + role pins in state.pins)
  SELECT ARRAY(
    SELECT DISTINCT p FROM (
      SELECT NEW.pin AS p WHERE NEW.pin IS NOT NULL AND NEW.pin <> ''
      UNION ALL
      SELECT value::text AS p
      FROM jsonb_each_text(COALESCE(NEW.state->'pins', '{}'::jsonb))
      WHERE value IS NOT NULL AND value <> ''
    ) sub
    WHERE p IS NOT NULL AND p <> ''
  ) INTO new_pins;

  IF new_pins IS NULL OR array_length(new_pins, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Look for any other sensor on the same device using any of these pins
  SELECT s.name, matched.pin INTO conflict_sensor_name, conflict_pin
  FROM public.sensors s
  CROSS JOIN LATERAL (
    SELECT p AS pin FROM (
      SELECT s.pin AS p WHERE s.pin IS NOT NULL AND s.pin <> ''
      UNION ALL
      SELECT value::text AS p
      FROM jsonb_each_text(COALESCE(s.state->'pins', '{}'::jsonb))
      WHERE value IS NOT NULL AND value <> ''
    ) sub
    WHERE p = ANY(new_pins)
  ) matched
  WHERE s.device_id = NEW.device_id
    AND s.id <> NEW.id
  LIMIT 1;

  IF conflict_pin IS NOT NULL THEN
    RAISE EXCEPTION 'Pin % is already used by sensor "%" on this device', conflict_pin, conflict_sensor_name
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_unique_sensor_pins_trg ON public.sensors;
CREATE TRIGGER enforce_unique_sensor_pins_trg
BEFORE INSERT OR UPDATE ON public.sensors
FOR EACH ROW EXECUTE FUNCTION public.enforce_unique_sensor_pins();
