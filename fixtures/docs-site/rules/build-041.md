---
title: Rule build-041
description: Reports when a manifest points at nothing.
---

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 24 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
