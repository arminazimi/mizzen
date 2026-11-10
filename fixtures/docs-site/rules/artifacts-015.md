# Rule artifacts-015

Reports when a log line is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 97 |

## Fix

Change the log line so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
