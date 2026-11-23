# مشخصات فنی

## دامنه

این پروژه فقط برای داده‌های MEXC USDT Futures و HARSI در تایم‌فریم 15 دقیقه است. ارتباطی با Futures-scan-A یا CCI1000 ندارد.

## دریافت بازار

- فهرست قراردادها: GET /api/v1/contract/detail
- تیکر همه قراردادها: GET /api/v1/contract/ticker
- فقط قراردادهای با quoteCoin = USDT، settleCoin = USDT و state = 0 بررسی می‌شوند.
- قیمت از lastPrice گرفته می‌شود؛ شرط قیمت: کمتر از 30 USDT.
- کندل‌ها: GET /api/v1/contract/kline/{symbol}?interval=Min15&start=...&end=...
- زمان‌های API بر حسب ثانیه Unix هستند.
- سقف پاسخ کندل 2,000 نقطه است؛ 2,000 کندل برای warm-up محاسبات درخواست می‌شود.
- فقط 288 کندل بسته‌شده آخر (سه روز) در دیتابیس باقی می‌مانند.

## کندل بسته‌شده و warm-up

زمان مرجع از endpoint زمان سرور MEXC گرفته می‌شود. کندل جاری 15 دقیقه‌ای حذف می‌شود. برای محاسبه پایدار RSI با طول 200، تا 2,000 کندل بسته‌شده دریافت می‌شود. کندل‌های warm-up فقط در حافظه Worker استفاده می‌شوند و ذخیره نمی‌شوند. از میان آن‌ها تنها 288 کندل بسته‌شده آخر در دیتابیس ثبت می‌شوند.

## فرمول HARSI بازیابی‌شده از Pine Script v4

منبع: JayRogers، اسکریپت "Heikin Ashi RSI Oscillator"، تابع f_rsiHeikinAshi().

- closeRSI = RSI(close, 200) - 50
- openRSI = nz(closeRSI[1], closeRSI)
- highRSI_raw = RSI(high, 200) - 50
- lowRSI_raw = RSI(low, 200) - 50
- highRSI = max(highRSI_raw, lowRSI_raw)
- lowRSI = min(highRSI_raw, lowRSI_raw)
- HA_Close = (openRSI + highRSI + lowRSI + closeRSI) / 4
- با Open Smoothing برابر 1، HA_Open ابتدا از میانگین openRSI و closeRSI شروع می‌شود و سپس از رابطه (HA_Open[1] + HA_Close[1]) / 2 پیروی می‌کند.
- HA_High = max(highRSI, HA_Open, HA_Close)
- HA_Low = min(lowRSI, HA_Open, HA_Close)
- RSI داخلی Pine از هموارسازی Wilder/RMA استفاده می‌کند؛ موتور JavaScript نیز همان seed اولیه SMA و سپس RMA را پیاده‌سازی می‌کند.
- شرط اسکن دقیقاً HA_Close > 5.5 است.

## تفکیک RSI نمودار از HARSI

در اسکریپت اصلی، i_lenRSI = 7 و i_source = OHLC4 فقط برای RSI plot و Stochastic RSI هستند. آن مسیر در نسخه اسکنر استفاده نمی‌شود، چون خروجی موردنیاز فقط کندل‌های HARSI است. طول RSI داخل تابع HARSI برابر i_lenHARSI = 200 است.

## پایگاه داده

- mexc_futures_ohlcv_15m: داده خام OHLCV
- mexc_harsi_results_15m: خروجی محاسبه HARSI، با کلید خارجی به کندل خام
- هر دو جدول RLS فعال دارند و برای دسترسی عمومی policy ندارند.
- کلید service role فقط در Worker خصوصی استفاده می‌شود.
- داده‌های قدیمی‌تر از سه روز از هر دو جدول پاک می‌شوند.

## اعتبارسنجی

آزمون‌های واحد، seed و بازگشت Wilder RSI، زمان اولین خروجی معتبر HARSI، ساختار OHLC کندل و شرط strict بزرگ‌تر از 5.5 را بررسی می‌کنند. تطبیق نهایی عددبه‌عدد با TradingView نیازمند مقایسه چند کندل مشترک از همان نماد و همان بازه تاریخی است؛ تا انجام این مقایسه، اجرای زنده روی داده واقعی نباید به‌عنوان تأیید نهایی تطبیق TradingView معرفی شود.
