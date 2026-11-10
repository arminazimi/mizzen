---
title: Rule build-042
description: Reports when a hook is empty.
---

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 62 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule build-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
