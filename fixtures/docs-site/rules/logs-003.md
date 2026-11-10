# Rule logs-003

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 77 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-003
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
