---
title: Rule deploy-021
description: Reports when a target uses a deprecated form.
---

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 89 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
