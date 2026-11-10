---
title: Rule hooks-042
description: Reports when a artifact is missing.
---

Reports when a artifact is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 21 |

## Fix

Change the artifact so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
