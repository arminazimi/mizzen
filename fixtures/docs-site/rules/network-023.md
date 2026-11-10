# Rule network-023

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 42 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule network-023
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
