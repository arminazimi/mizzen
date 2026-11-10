---
title: Rule deploy-033
description: Reports when a build step is duplicated.
---

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 10 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
