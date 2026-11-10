# Rule logs-036

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 64 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
