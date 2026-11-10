---
title: Rule secrets-003
description: Reports when a target is not readable.
---

Reports when a target is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 82 |

## Fix

Change the target so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
