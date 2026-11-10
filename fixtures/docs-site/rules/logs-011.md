# Rule logs-011

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 78 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
