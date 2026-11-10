# Rule network-026

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 78 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-026
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
