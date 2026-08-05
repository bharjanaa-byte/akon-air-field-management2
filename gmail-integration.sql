-- Run this once in the Supabase SQL Editor. This table is server-only:
-- RLS is enabled and no browser policies are created.
create table if not exists public.gmail_integrations (
  company_id uuid primary key references public.companies(id) on delete cascade,
  connected_by uuid not null references auth.users(id) on delete cascade,
  gmail_address text,
  refresh_token text not null,
  last_message_id text,
  last_import_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gmail_integrations enable row level security;
