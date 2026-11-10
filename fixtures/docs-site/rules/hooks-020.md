---
title: Rule hooks-020
description: Reports when a manifest uses a deprecated form.
---

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 85 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
