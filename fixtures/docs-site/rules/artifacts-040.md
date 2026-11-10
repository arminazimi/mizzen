---
title: Rule artifacts-040
description: Reports when a log line uses a deprecated form.
---

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 53 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
