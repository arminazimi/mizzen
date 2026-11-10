---
title: Rule logs-053
description: Reports when a manifest uses a deprecated form.
---

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 97 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-053
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
