---
title: پیکربندی
description: فایل beacon.yml و کلیدهای آن.
---

# پیکربندی

فایل `beacon.yml` در ریشهٔ پروژه قرار می‌گیرد. فقط کلید `build` اجباری است.

## نمونه

```yaml
build: npm run build
publish: dist
environments:
  staging:
    target: s3://beacon-staging
  production:
    target: s3://beacon-prod
```

| کلید | معنی | پیش‌فرض |
| --- | --- | --- |
| `build` | دستور ساخت | ندارد |
| `publish` | پوشهٔ آپلود | `dist` |
| `environments` | محیط‌ها | خالی |

مقدارها به این ترتیب خوانده می‌شوند: پرچم‌ها، سپس متغیرهای محیطی، سپس فایل. زمان انتظار پیش‌فرض ۳۰ ثانیه (30s) است.
