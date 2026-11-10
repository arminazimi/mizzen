---
title: Rule targets-031
description: Reports when a release is empty.
---

Reports when a release is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 36 |

## Fix

Change the release so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
