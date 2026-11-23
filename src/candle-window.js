export const FIFTEEN_MINUTES_SECONDS = 15 * 60;

export function calculateClosedCandleWindow(serverNowMs, historyDays = 3) {
  if (!Number.isFinite(serverNowMs) || serverNowMs <= 0) {
    throw new Error("serverNowMs must be a positive timestamp.");
  }
  if (historyDays !== 3) {
    throw new Error("This scanner keeps exactly three days of candle history.");
  }

  const nowSeconds = Math.floor(serverNowMs / 1000);
  const currentCandleOpen = Math.floor(nowSeconds / FIFTEEN_MINUTES_SECONDS) * FIFTEEN_MINUTES_SECONDS;
  const latestClosedOpen = currentCandleOpen - FIFTEEN_MINUTES_SECONDS;
  const startSeconds = latestClosedOpen - (historyDays * 24 * 60 * 60) + FIFTEEN_MINUTES_SECONDS;

  return { startSeconds, endSeconds: latestClosedOpen, latestClosedOpen };
}
