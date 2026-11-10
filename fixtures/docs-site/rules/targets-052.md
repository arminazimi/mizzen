---
title: Rule targets-052
description: Reports when a release is missing.
---

Reports when a release is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 60 |

## Fix

Change the release so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
