# Rule logs-031

Reports when a cache entry is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 25 |

## Fix

Change the cache entry so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
