# Rule logs-054

Reports when a environment is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 50 |

## Fix

Change the environment so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
