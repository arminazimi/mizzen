---
title: Rule config-041
description: Reports when a target is larger than the limit.
---

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 16 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
