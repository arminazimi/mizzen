---
title: Rule deploy-023
description: Reports when a artifact points at nothing.
---

Reports when a artifact points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 61 |

## Fix

Change the artifact so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
