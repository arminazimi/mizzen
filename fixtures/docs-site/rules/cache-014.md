# Rule cache-014

Reports when a log line is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 28 |

## Fix

Change the log line so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
