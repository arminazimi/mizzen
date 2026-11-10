# Rule cache-055

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 96 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
