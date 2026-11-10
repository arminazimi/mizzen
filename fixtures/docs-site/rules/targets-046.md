# Rule targets-046

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 48 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
