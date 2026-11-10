---
title: Rule config-006
description: Reports when a build step is older than expected.
---

Reports when a build step is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 11 |

## Fix

Change the build step so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule config-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
