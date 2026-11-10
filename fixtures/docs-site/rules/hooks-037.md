---
title: Rule hooks-037
description: Reports when a hook uses a deprecated form.
---

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 81 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
