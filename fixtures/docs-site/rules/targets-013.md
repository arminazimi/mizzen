---
title: Rule targets-013
description: Reports when a environment is older than expected.
---

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 79 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
