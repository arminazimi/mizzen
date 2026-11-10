---
title: Rule config-023
description: Reports when a release uses a deprecated form.
---

Reports when a release uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 15 |

## Fix

Change the release so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule config-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
