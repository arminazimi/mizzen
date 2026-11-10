# Rule deploy-034

Reports when a log line is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 65 |

## Fix

Change the log line so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
