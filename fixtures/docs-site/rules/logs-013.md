# Rule logs-013

Reports when a token is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 30 |

## Fix

Change the token so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
