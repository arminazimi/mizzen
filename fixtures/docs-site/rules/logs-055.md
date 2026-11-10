# Rule logs-055

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 74 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
