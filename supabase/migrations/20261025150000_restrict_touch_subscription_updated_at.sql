-- The trigger function is SECURITY DEFINER so it can stamp updated_at on a
-- table the browser may not write to. It must not also be callable directly
-- through the REST RPC endpoint.
revoke execute on function public.touch_subscription_updated_at() from public, anon, authenticated;
