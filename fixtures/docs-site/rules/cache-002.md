---
title: Rule cache-002
description: Reports when a target uses a deprecated form.
---

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 48 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
