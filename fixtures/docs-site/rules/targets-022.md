---
title: Rule targets-022
description: Reports when a build step is empty.
---

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 91 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
