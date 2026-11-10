---
title: Rule targets-016
description: Reports when a artifact is duplicated.
---

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 1 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
