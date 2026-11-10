---
title: Rule config-045
description: Reports when a release is older than expected.
---

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 14 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
