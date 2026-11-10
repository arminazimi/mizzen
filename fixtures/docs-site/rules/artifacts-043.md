---
title: Rule artifacts-043
description: Reports when a hook is not readable.
---

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 83 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
