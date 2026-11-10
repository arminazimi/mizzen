# Rule logs-038

Reports when a artifact is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 30 |

## Fix

Change the artifact so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
