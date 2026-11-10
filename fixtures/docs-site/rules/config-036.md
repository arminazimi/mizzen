---
title: Rule config-036
description: Reports when a hook is empty.
---

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 59 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule config-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
