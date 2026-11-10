---
title: Rule artifacts-013
description: Reports when a hook is empty.
---

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 69 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
