# Rule logs-016

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 80 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
