---
title: Rule artifacts-055
description: Reports when a hook uses a deprecated form.
---

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 37 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
