---
title: Rule deploy-004
description: Reports when a artifact is larger than the limit.
---

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 5 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
