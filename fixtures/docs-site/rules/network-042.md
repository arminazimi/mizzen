---
title: Rule network-042
description: Reports when a hook is larger than the limit.
---

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 36 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
