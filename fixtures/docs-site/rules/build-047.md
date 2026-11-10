---
title: Rule build-047
description: Reports when a target points at nothing.
---

Reports when a target points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 87 |

## Fix

Change the target so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
