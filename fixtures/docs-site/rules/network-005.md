---
title: Rule network-005
description: Reports when a environment uses a deprecated form.
---

Reports when a environment uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 85 |

## Fix

Change the environment so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
