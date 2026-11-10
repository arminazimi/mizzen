# Rule cache-016

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 7 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-016
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
