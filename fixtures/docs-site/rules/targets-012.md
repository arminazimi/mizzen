---
title: Rule targets-012
description: Reports when a hook is not readable.
---

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 85 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
