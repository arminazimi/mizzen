# Rule logs-058

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 1 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-058
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
