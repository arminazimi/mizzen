# Rule network-031

Reports when a log line is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 9 |

## Fix

Change the log line so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule network-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
