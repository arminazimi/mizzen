# Rule config-017

Reports when a cache entry is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 20 |

## Fix

Change the cache entry so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-017
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
