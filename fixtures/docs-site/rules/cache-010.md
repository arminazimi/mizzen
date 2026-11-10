# Rule cache-010

Reports when a target is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `warning` |
| Limit | 12 |

## Fix

Change the target so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
