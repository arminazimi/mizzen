---
title: Rule network-018
description: Reports when a artifact is not readable.
---

Reports when a artifact is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 76 |

## Fix

Change the artifact so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule network-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
