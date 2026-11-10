---
title: Rule targets-041
description: Reports when a hook points at nothing.
---

Reports when a hook points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 40 |

## Fix

Change the hook so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
