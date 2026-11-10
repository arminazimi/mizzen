---
title: Rule deploy-007
description: Reports when a manifest is older than expected.
---

Reports when a manifest is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 61 |

## Fix

Change the manifest so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
