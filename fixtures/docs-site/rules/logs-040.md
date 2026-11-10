# Rule logs-040

Reports when a release points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 62 |

## Fix

Change the release so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
