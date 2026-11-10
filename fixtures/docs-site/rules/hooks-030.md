---
title: Rule hooks-030
description: Reports when a target uses a deprecated form.
---

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 10 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
