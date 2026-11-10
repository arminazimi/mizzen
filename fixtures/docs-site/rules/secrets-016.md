---
title: Rule secrets-016
description: Reports when a release is missing.
---

Reports when a release is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 10 |

## Fix

Change the release so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
