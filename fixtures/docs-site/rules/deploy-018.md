---
title: Rule deploy-018
description: Reports when a token is larger than the limit.
---

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `info` |
| Limit | 56 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
