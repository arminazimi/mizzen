---
title: Rule build-009
description: Reports when a artifact uses a deprecated form.
---

Reports when a artifact uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 79 |

## Fix

Change the artifact so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
