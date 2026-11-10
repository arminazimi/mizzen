# Rule cache-018

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 10 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
