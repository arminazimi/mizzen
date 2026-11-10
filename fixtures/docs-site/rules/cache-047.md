---
title: Rule cache-047
description: Reports when a release is older than expected.
---

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 80 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
