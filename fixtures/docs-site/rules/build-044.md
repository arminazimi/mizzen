---
title: Rule build-044
description: Reports when a token uses a deprecated form.
---

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 45 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
