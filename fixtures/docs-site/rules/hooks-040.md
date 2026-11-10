---
title: Rule hooks-040
description: Reports when a release points at nothing.
---

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 25 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
