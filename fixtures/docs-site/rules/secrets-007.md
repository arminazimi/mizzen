# Rule secrets-007

Reports when a log line is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 76 |

## Fix

Change the log line so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
