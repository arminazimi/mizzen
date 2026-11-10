---
title: Rule cache-004
description: Reports when a hook uses a deprecated form.
---

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 72 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
