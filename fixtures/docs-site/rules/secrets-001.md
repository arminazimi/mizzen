# Rule secrets-001

Reports when a cache entry points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 11 |

## Fix

Change the cache entry so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
