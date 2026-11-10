---
title: دستورها
description: دستورهای روزمرهٔ بیکن.
---

# دستورها

| دستور | کار |
| --- | --- |
| `beacon init` | فایل `beacon.yml` را می‌نویسد |
| `beacon build` | دستور ساخت را اجرا می‌کند |
| `beacon deploy` | مصنوع را آپلود می‌کند |
| `beacon rollback` | محیط را به مصنوع قدیمی‌تر برمی‌گرداند |

## استقرار

```bash
beacon deploy staging --dry-run
beacon deploy production
```

با `--dry-run` فقط چاپ می‌شود چه چیزی آپلود می‌شد. برای خروجی ماشینی از `--json` استفاده کنید؛ هر مرحله یک شیء JSON است و مقدار `url` نشانی نهایی را دارد.

حداکثر ۵ نسخهٔ اخیر با `beacon releases --limit 5` نمایش داده می‌شود.
