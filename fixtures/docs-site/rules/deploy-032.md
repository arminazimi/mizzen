---
title: Rule deploy-032
description: Reports when a hook points at nothing.
---

Reports when a hook points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 71 |

## Fix

Change the hook so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-032
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
