---
title: Rule config-016
description: Reports when a cache entry uses a deprecated form.
---

Reports when a cache entry uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 59 |

## Fix

Change the cache entry so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule config-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
