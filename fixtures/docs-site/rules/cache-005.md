---
title: Rule cache-005
description: Reports when a hook is empty.
---

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 63 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
