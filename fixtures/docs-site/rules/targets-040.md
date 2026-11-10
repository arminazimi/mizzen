# Rule targets-040

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 43 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
