---
title: Rule network-027
description: Reports when a manifest uses a deprecated form.
---

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 75 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
