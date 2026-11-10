---
title: Rule deploy-051
description: Reports when a manifest is duplicated.
---

Reports when a manifest is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 75 |

## Fix

Change the manifest so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
