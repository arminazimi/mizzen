---
title: Rule artifacts-017
description: Reports when a manifest uses a deprecated form.
---

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 39 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
