---
title: Rule hooks-002
description: Reports when a release is older than expected.
---

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 42 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
