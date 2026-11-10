---
title: Rule targets-039
description: Reports when a build step uses a deprecated form.
---

Reports when a build step uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 59 |

## Fix

Change the build step so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
