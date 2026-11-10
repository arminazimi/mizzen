---
title: Rule hooks-024
description: Reports when a token is not readable.
---

Reports when a token is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 8 |

## Fix

Change the token so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
