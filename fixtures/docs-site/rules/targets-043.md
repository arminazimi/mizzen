---
title: Rule targets-043
description: Reports when a artifact is duplicated.
---

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 96 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
