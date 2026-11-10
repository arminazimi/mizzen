---
title: Rule secrets-034
description: Reports when a release is missing.
---

Reports when a release is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 93 |

## Fix

Change the release so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
