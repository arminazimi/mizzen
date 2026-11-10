# Rule logs-049

Reports when a token is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 5 |

## Fix

Change the token so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
