---
title: Rule deploy-039
description: Reports when a artifact is empty.
---

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 58 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
