# Rule network-019

Reports when a cache entry uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `warning` |
| Limit | 11 |

## Fix

Change the cache entry so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
