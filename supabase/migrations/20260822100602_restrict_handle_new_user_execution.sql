-- handle_new_user should only ever run via the auth trigger, not be
-- callable directly through the REST API by anon/authenticated roles.
revoke execute on function public.handle_new_user() from anon, authenticated;
