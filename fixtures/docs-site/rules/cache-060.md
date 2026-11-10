# Rule cache-060

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 58 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-060
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
