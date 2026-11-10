# Rule cache-015

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 77 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
