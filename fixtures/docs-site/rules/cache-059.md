# Rule cache-059

Reports when a manifest is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 95 |

## Fix

Change the manifest so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-059
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
