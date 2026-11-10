---
title: Rule secrets-042
description: Reports when a artifact is duplicated.
---

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 61 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
