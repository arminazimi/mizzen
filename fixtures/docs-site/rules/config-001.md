---
title: Rule config-001
description: Reports when a release is empty.
---

Reports when a release is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 66 |

## Fix

Change the release so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule config-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
