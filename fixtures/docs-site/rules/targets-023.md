---
title: Rule targets-023
description: Reports when a token uses a deprecated form.
---

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 23 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
