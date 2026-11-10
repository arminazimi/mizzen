---
title: Rule hooks-038
description: Reports when a artifact is larger than the limit.
---

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 42 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
