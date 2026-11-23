-- Run before deploying the persisted 2,000-candle history cache.
-- Widen OHLC numeric scale so reading cached candles reproduces the original
-- JavaScript Number values without the old 12-decimal database rounding.
ALTER TABLE public.mexc_futures_ohlcv_15m
  ALTER COLUMN open_price TYPE numeric(60,40) USING open_price::numeric(60,40),
  ALTER COLUMN high_price TYPE numeric(60,40) USING high_price::numeric(60,40),
  ALTER COLUMN low_price TYPE numeric(60,40) USING low_price::numeric(60,40),
  ALTER COLUMN close_price TYPE numeric(60,40) USING close_price::numeric(60,40);
