-- Private bucket for uploaded trading documents (broker statements, CSVs,
-- screenshots, strategy docs). Files are stored under {user_id}/{filename}
-- so folder-based policies can scope access per user.
insert into storage.buckets (id, name, public, file_size_limit)
values ('trading-sources', 'trading-sources', false, 26214400); -- 25MB limit

create policy "Users can view their own uploaded files"
  on storage.objects for select
  using (
    bucket_id = 'trading-sources'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "Users can upload their own files"
  on storage.objects for insert
  with check (
    bucket_id = 'trading-sources'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own uploaded files"
  on storage.objects for delete
  using (
    bucket_id = 'trading-sources'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
