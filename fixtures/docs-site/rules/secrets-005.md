# Rule secrets-005

Reports when a log line is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 23 |

## Fix

Change the log line so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-005
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
