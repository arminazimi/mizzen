---
title: Rule logs-014
description: Reports when a environment uses a deprecated form.
---

Reports when a environment uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 46 |

## Fix

Change the environment so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
