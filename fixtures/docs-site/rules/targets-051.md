# Rule targets-051

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 43 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-051
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
