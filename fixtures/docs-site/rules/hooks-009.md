---
title: Rule hooks-009
description: Reports when a token is older than expected.
---

Reports when a token is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 85 |

## Fix

Change the token so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
