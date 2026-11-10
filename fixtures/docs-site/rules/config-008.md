---
title: Rule config-008
description: Reports when a hook is older than expected.
---

Reports when a hook is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 32 |

## Fix

Change the hook so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
