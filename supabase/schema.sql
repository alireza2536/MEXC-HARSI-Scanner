-- MEXC-HARSI-Scanner: 15m USDT futures candle history
-- Only closed candles should be inserted by the worker.

create table if not exists public.mexc_harsi_15m (
  symbol text not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open_price numeric(30, 12) not null,
  high_price numeric(30, 12) not null,
  low_price numeric(30, 12) not null,
  close_price numeric(30, 12) not null,
  volume numeric(36, 12),
  amount numeric(36, 12),
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
  constraint mexc_harsi_15m_pk primary key (symbol, open_time),
  constraint mexc_harsi_15m_valid_time check (close_time > open_time)
);

create index if not exists mexc_harsi_15m_close_time_idx
  on public.mexc_harsi_15m (close_time desc);

create index if not exists mexc_harsi_15m_match_idx
  on public.mexc_harsi_15m (scan_match, close_time desc)
  where scan_match is true;

-- Run periodically (for example, hourly) from a trusted scheduler.
delete from public.mexc_harsi_15m
where close_time < now() - interval '3 days';
