---
title: Rule hooks-017
description: Reports when a artifact is older than expected.
---

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 84 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
