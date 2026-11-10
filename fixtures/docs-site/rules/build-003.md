---
title: Rule build-003
description: Reports when a artifact is larger than the limit.
---

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 18 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
