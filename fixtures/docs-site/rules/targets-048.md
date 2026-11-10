---
title: Rule targets-048
description: Reports when a target is duplicated.
---

Reports when a target is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 56 |

## Fix

Change the target so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
