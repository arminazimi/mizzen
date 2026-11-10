# Rule logs-035

Reports when a log line is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 51 |

## Fix

Change the log line so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
