---
title: Rule targets-027
description: Reports when a artifact is larger than the limit.
---

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 71 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
