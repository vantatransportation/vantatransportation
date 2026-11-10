-- Workflow additions: duplicate-submission protection, customer quote responses,
-- and stored notification payloads (needed for retry).

alter table public.bookings
  add column if not exists submission_key text unique;

alter table public.quote_requests
  add column if not exists access_token text not null
    default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  add column if not exists customer_response text not null default 'pending'
    check (customer_response in ('pending','accepted','rejected')),
  add column if not exists customer_responded_at timestamptz,
  add column if not exists revised_sent_at timestamptz,
  add column if not exists submission_key text unique;

create unique index if not exists quote_requests_token_uniq on public.quote_requests(access_token);

alter table public.notification_logs
  add column if not exists payload jsonb not null default '{}'::jsonb;
