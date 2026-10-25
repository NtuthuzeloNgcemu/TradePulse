alter table public.playbook_rules
  drop constraint playbook_rules_status_check,
  add constraint playbook_rules_status_check check (status in ('confirmed', 'suggested', 'rejected', 'archived'));

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
