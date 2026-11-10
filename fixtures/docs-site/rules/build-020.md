# Rule build-020

Reports when a log line is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the log line so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule build-020
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
