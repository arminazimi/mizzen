---
title: Rule artifacts-034
description: Reports when a artifact is empty.
---

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 57 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
