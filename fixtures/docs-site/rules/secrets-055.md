# Rule secrets-055

Reports when a cache entry is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 3 |

## Fix

Change the cache entry so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
