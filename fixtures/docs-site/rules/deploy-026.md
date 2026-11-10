---
title: Rule deploy-026
description: Reports when a log line uses a deprecated form.
---

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 43 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
