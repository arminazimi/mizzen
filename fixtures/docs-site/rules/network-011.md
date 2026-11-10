# Rule network-011

Reports when a log line is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 48 |

## Fix

Change the log line so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule network-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
