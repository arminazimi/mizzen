# Rule targets-030

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `info` |
| Limit | 92 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
