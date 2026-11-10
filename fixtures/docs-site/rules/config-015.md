---
title: Rule config-015
description: Reports when a environment is missing.
---

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 54 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
