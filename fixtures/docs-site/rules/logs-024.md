# Rule logs-024

Reports when a cache entry is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 32 |

## Fix

Change the cache entry so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
