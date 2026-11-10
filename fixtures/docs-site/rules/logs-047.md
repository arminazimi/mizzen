# Rule logs-047

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 11 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
