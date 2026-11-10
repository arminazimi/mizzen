---
title: Rule hooks-057
description: Reports when a release is older than expected.
---

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 6 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-057
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
