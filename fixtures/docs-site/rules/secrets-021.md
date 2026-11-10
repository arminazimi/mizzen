---
title: Rule secrets-021
description: Reports when a target is older than expected.
---

Reports when a target is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 91 |

## Fix

Change the target so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
