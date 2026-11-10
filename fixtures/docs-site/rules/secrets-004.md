---
title: Rule secrets-004
description: Reports when a release is duplicated.
---

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 93 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
