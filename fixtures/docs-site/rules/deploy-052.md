---
title: Rule deploy-052
description: Reports when a release is empty.
---

Reports when a release is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 80 |

## Fix

Change the release so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
