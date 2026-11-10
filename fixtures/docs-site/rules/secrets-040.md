# Rule secrets-040

Reports when a log line is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the log line so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
