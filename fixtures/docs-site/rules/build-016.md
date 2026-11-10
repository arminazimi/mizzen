# Rule build-016

Reports when a log line uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 77 |

## Fix

Change the log line so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
