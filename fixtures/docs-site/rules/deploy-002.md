# Rule deploy-002

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 56 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-002
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
