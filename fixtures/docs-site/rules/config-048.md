---
title: Rule config-048
description: Reports when a token points at nothing.
---

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 84 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
