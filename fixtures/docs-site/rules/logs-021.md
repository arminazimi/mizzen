# Rule logs-021

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 71 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
