# Rule logs-010

Reports when a manifest is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 78 |

## Fix

Change the manifest so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
