---
title: Rule build-026
description: Reports when a token uses a deprecated form.
---

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 28 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
