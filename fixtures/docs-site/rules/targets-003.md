---
title: Rule targets-003
description: Reports when a target is older than expected.
---

Reports when a target is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 58 |

## Fix

Change the target so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
