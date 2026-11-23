# MEXC-HARSI-Scanner

اسکنر مستقل HARSI برای قراردادهای USDT-M Futures صرافی MEXC.

## مشخصات

- بازار: قراردادهای فعال USDT Futures در MEXC
- فیلتر قیمت: کمتر از 10 USDT بر اساس آخرین قیمت معامله
- تایم‌فریم: 15 دقیقه
- تاریخچه: 3 روز، معادل 288 کندل بسته‌شده برای هر نماد
- ذخیره OHLCV خام در Neon PostgreSQL
- جدول جداگانه برای خروجی‌های HARSI تا ذخیره مجدد کندل‌ها محاسبات را بازنویسی نکند
- حذف داده‌های قدیمی‌تر از 3 روز
- شرط هدف HARSI: `HA_Close > 5.5`؛ محاسبه HARSI تا تطبیق کامل Pine Script عمداً غیرفعال است.

## اجرا

نیازمند Node.js 22 یا بالاتر است.

```bash
npm install
cp .env.example .env
# مقدار DATABASE_URL را در .env قرار دهید
npm run build
npm test
npm run scan
```

در محیط Render، متغیر `DATABASE_URL` را به‌صورت Secret Environment Variable تنظیم کنید؛ فایل .env را در Git ثبت نکنید.

## روند اسکن

1. زمان سرور MEXC خوانده می‌شود.
2. قراردادهای فعال USDT با قیمت کمتر از 10 USDT انتخاب می‌شوند.
3. برای هر قرارداد، کندل‌های 15 دقیقه‌ای سه روز اخیر دریافت می‌شوند.
4. کندل در حال تشکیل حذف می‌شود؛ فقط کندل‌های بسته‌شده ذخیره می‌شوند.
5. داده‌ها با کلید یکتای نماد و زمان شروع کندل در Neon upsert می‌شوند.
6. داده‌های قدیمی‌تر از سه روز از هر دو جدول پاک می‌شوند.

## ساختار

- `src/mexc-client.js`: ارتباط عمومی با API فیوچرز MEXC
- `src/scanner.js`: اجرای اسکن تاریخچه
- `src/neon-store.js`: ذخیره‌سازی و پاکسازی در Neon PostgreSQL
- `neon/schema.sql`: ساختار جداول PostgreSQL
- `docs/technical-spec.md`: مشخصات و ملاحظات HARSI

## امنیت

فقط `DATABASE_URL` را در محیط خصوصی Worker/Render تنظیم کنید. هرگز آن را در مرورگر، لاگ‌ها یا Git ثبت نکنید.
