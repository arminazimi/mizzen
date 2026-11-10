# Rule hooks-049

Reports when a log line is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 47 |

## Fix

Change the log line so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
