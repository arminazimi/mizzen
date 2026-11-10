# Rule logs-052

Reports when a target is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 88 |

## Fix

Change the target so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
