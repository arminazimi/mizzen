---
title: Rule config-021
description: Reports when a manifest is empty.
---

Reports when a manifest is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 43 |

## Fix

Change the manifest so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule config-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
