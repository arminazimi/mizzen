---
title: Rule secrets-013
description: Reports when a hook points at nothing.
---

Reports when a hook points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 37 |

## Fix

Change the hook so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
