create table if not exists otp_requests (
  id uuid primary key default gen_random_uuid(),
  customer_phone text not null check (customer_phone ~ '^[6-9][0-9]{9}$'),
  otp text not null,                -- AES-256-GCM encrypted, never plaintext
  otp_fp text not null,             -- HMAC fingerprint used for verify + uniqueness
  status text not null default 'pending' check (status in ('pending','sent','verified','expired','failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz, verified_at timestamptz,
  verified boolean not null default false,
  attempt_count int not null default 0,
  send_count int not null default 0,
  generated_by text not null,
  ip_address text
);
create unique index if not exists one_active_otp_value on otp_requests(otp_fp) where status in ('pending','sent');
create index if not exists otp_phone_idx on otp_requests(customer_phone, created_at desc);
create table if not exists audit_logs (
  id bigserial primary key, created_at timestamptz not null default now(),
  actor text, action text not null, detail text, ip_address text
);
-- Backend uses the service-role key only. Block all direct client access:
alter table otp_requests enable row level security;
alter table audit_logs enable row level security;

-- Orders received from the customer portal (only needed if you use Supabase storage)
create table if not exists orders (
  order_id text primary key,
  status text not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index if not exists orders_created_idx on orders (created_at desc);
alter table orders enable row level security;
