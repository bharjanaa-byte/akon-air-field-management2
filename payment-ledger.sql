-- Run once in Supabase SQL Editor. This makes uploaded GoLime payment
-- invoices and follow-ups available to every device in the same workspace.
create table if not exists public.payment_ledgers (
  company_id uuid primary key references public.companies(id) on delete cascade,
  invoices jsonb not null default '[]'::jsonb,
  followups jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.payment_ledgers enable row level security;

drop policy if exists "Workspace members can read payment ledgers" on public.payment_ledgers;
create policy "Workspace members can read payment ledgers"
on public.payment_ledgers for select
using (exists (select 1 from public.company_members m where m.company_id = payment_ledgers.company_id and m.user_id = auth.uid()));

drop policy if exists "Workspace members can create payment ledgers" on public.payment_ledgers;
create policy "Workspace members can create payment ledgers"
on public.payment_ledgers for insert
with check (exists (select 1 from public.company_members m where m.company_id = payment_ledgers.company_id and m.user_id = auth.uid()));

drop policy if exists "Workspace members can update payment ledgers" on public.payment_ledgers;
create policy "Workspace members can update payment ledgers"
on public.payment_ledgers for update
using (exists (select 1 from public.company_members m where m.company_id = payment_ledgers.company_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.company_members m where m.company_id = payment_ledgers.company_id and m.user_id = auth.uid()));
