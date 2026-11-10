---
title: Rule hooks-004
description: Reports when a hook is empty.
---

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 46 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
