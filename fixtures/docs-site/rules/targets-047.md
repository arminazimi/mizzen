---
title: Rule targets-047
description: Reports when a release is duplicated.
---

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 5 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
