# Rule logs-045

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `info` |
| Limit | 65 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
