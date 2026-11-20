-- 0008: customer <-> assigned-driver chat. ADDITIVE AND IDEMPOTENT. Run AFTER 0007.
-- Access model: customers use their private booking link, drivers use their signed-in session. Both reach messages ONLY through
-- server routes that verify ownership with the service role. No policy grants customers or drivers direct table access, so querying
-- Supabase directly returns nothing. Admin policy: administrators may READ conversations (support and dispute handling); the admin
-- UI offers no posting.
create table if not exists public.booking_messages (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  -- The driver assigned when the message was sent. A driver only ever sees messages from their own assignment.
  driver_id uuid references public.drivers(id) on delete set null,
  sender_role text not null check (sender_role in ('customer','driver')),
  body text not null check (length(body) between 1 and 1000),
  quick_reply boolean not null default false,
  -- booking id + client-generated id: a retried send cannot create a duplicate message.
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists booking_messages_idx on public.booking_messages(booking_id, created_at);
alter table public.booking_messages enable row level security;
drop policy if exists "admin full access" on public.booking_messages;
create policy "admin full access" on public.booking_messages for all to authenticated using (public.is_admin()) with check (public.is_admin());
