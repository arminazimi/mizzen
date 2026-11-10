# Rule logs-015

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 58 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
