-- Postgres grants EXECUTE to PUBLIC by default on function creation, which is
-- the actual source of the anon/authenticated access, not a direct grant to
-- those roles. Revoking from PUBLIC is what actually closes this off.
revoke execute on function public.handle_new_user() from public;
