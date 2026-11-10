---
title: Rule deploy-008
description: Reports when a build step uses a deprecated form.
---

Reports when a build step uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 73 |

## Fix

Change the build step so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
