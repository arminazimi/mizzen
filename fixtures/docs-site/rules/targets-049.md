# Rule targets-049

Reports when a log line is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 82 |

## Fix

Change the log line so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
