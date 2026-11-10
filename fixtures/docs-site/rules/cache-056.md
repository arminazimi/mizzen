---
title: Rule cache-056
description: Reports when a artifact points at nothing.
---

Reports when a artifact points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 28 |

## Fix

Change the artifact so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
