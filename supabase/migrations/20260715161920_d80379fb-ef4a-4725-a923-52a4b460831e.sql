-- Fix device claim hijack + token exposure.
-- Previously any authenticated user could read pending unassigned devices
-- (including their device_token and MAC) and claim them by UPDATE. Restrict
-- reads to owned devices only, and require MAC (proof of physical possession)
-- to claim, via a SECURITY DEFINER function.

DROP POLICY IF EXISTS "read own or pending unassigned" ON public.devices;
DROP POLICY IF EXISTS "claim pending" ON public.devices;

CREATE POLICY "read own"
ON public.devices FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.claim_device(_mac text)
RETURNS public.devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  norm_mac text := upper(trim(_mac));
  claimed public.devices;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF norm_mac IS NULL OR norm_mac = '' THEN
    RAISE EXCEPTION 'mac required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.devices
     SET user_id = auth.uid(),
         status  = 'approved'
   WHERE mac = norm_mac
     AND status = 'pending'
     AND user_id IS NULL
  RETURNING id, mac, name, status, device_token, user_id, fw_version, last_seen, created_at
       INTO claimed;

  IF claimed.id IS NULL THEN
    RAISE EXCEPTION 'no pending device with that MAC' USING ERRCODE = 'P0002';
  END IF;

  -- Never return the device_token to the client; it is a device-only secret.
  claimed.device_token := NULL;
  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_device(text) TO authenticated;