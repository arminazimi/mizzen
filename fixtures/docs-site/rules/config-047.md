---
title: Rule config-047
description: Reports when a token is missing.
---

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 83 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
