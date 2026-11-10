# Rule cache-022

Reports when a release is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 65 |

## Fix

Change the release so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
