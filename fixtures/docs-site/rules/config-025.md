---
title: Rule config-025
description: Reports when a manifest is missing.
---

Reports when a manifest is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 42 |

## Fix

Change the manifest so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
