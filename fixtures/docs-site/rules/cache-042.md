# Rule cache-042

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 65 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
