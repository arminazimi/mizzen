---
title: Rule cache-044
description: Reports when a environment uses a deprecated form.
---

Reports when a environment uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 59 |

## Fix

Change the environment so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
