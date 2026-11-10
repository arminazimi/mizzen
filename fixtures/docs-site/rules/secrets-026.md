---
title: Rule secrets-026
description: Reports when a hook is duplicated.
---

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 6 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
