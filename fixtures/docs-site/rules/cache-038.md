---
title: Rule cache-038
description: Reports when a artifact uses a deprecated form.
---

Reports when a artifact uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 36 |

## Fix

Change the artifact so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
