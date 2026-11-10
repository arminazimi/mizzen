---
title: Rule config-038
description: Reports when a environment is duplicated.
---

Reports when a environment is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 46 |

## Fix

Change the environment so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule config-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
