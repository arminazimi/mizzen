# Rule artifacts-031

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 84 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
