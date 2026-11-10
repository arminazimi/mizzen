# Rule config-012

Reports when a log line is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 66 |

## Fix

Change the log line so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
