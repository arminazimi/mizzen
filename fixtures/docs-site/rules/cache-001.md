# Rule cache-001

Reports when a release is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 11 |

## Fix

Change the release so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-001
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
