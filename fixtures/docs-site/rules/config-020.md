---
title: Rule config-020
description: Reports when a environment is empty.
---

Reports when a environment is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 63 |

## Fix

Change the environment so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule config-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
