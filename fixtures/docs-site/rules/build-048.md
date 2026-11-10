---
title: Rule build-048
description: Reports when a release uses a deprecated form.
---

Reports when a release uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 60 |

## Fix

Change the release so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
