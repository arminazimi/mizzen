---
title: Rule targets-004
description: Reports when a release points at nothing.
---

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 73 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
