---
title: Rule targets-036
description: Reports when a environment is larger than the limit.
---

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 2 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
