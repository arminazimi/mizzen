# Rule config-035

Reports when a cache entry is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 92 |

## Fix

Change the cache entry so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
