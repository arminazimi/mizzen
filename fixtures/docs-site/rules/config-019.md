# Rule config-019

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 12 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
