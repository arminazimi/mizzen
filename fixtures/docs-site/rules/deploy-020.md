---
title: Rule deploy-020
description: Reports when a environment uses a deprecated form.
---

Reports when a environment uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 5 |

## Fix

Change the environment so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
