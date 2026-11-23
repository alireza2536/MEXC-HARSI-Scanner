-- MEXC-HARSI-Scanner: separate raw candles from calculated indicator results.
-- Both tables are private to the server-side worker. No anon/authenticated policies.

create table if not exists public.mexc_futures_ohlcv_15m (
  symbol text not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open_price numeric(30, 12) not null,
  high_price numeric(30, 12) not null,
  low_price numeric(30, 12) not null,
  close_price numeric(30, 12) not null,
  volume numeric(36, 12),
  amount numeric(36, 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mexc_futures_ohlcv_15m_pk primary key (symbol, open_time),
  constraint mexc_futures_ohlcv_15m_valid_time check (close_time > open_time)
);

create index if not exists mexc_futures_ohlcv_15m_close_time_idx
  on public.mexc_futures_ohlcv_15m (close_time desc);

create table if not exists public.mexc_harsi_results_15m (
  symbol text not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  rsi_open numeric(20, 10),
  rsi_high numeric(20, 10),
  rsi_low numeric(20, 10),
  rsi_close numeric(20, 10),
  ha_open numeric(20, 10),
  ha_high numeric(20, 10),
  ha_low numeric(20, 10),
  ha_close numeric(20, 10),
  scan_match boolean,
  calculation_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mexc_harsi_results_15m_pk primary key (symbol, open_time),
  constraint mexc_harsi_results_15m_candle_fk
    foreign key (symbol, open_time)
    references public.mexc_futures_ohlcv_15m (symbol, open_time)
    on delete cascade,
  constraint mexc_harsi_results_15m_valid_time check (close_time > open_time)
);

create index if not exists mexc_harsi_results_15m_match_idx
  on public.mexc_harsi_results_15m (scan_match, close_time desc)
  where scan_match is true;

alter table public.mexc_futures_ohlcv_15m enable row level security;
alter table public.mexc_harsi_results_15m enable row level security;

-- Keep both tables server-only. Do not grant anon/authenticated access.
-- The service-role key must exist only in the private worker environment.
