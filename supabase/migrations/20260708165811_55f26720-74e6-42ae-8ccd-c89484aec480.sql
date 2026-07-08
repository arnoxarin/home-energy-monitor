
ALTER FUNCTION public.enforce_unique_sensor_pins() SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION public.enforce_unique_sensor_pins() FROM PUBLIC, anon, authenticated;
