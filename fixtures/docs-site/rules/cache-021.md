---
title: Rule cache-021
description: Reports when a hook is not readable.
---

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 50 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
