# Rule hooks-041

Reports when a log line is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 31 |

## Fix

Change the log line so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-041
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
