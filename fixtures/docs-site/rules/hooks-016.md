---
title: Rule hooks-016
description: Reports when a hook is not readable.
---

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 83 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
