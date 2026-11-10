---
title: Rule config-003
description: Reports when a artifact points at nothing.
---

Reports when a artifact points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 72 |

## Fix

Change the artifact so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
