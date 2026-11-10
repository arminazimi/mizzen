# Rule cache-052

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 47 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-052
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
