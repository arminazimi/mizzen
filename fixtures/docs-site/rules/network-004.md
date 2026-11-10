# Rule network-004

Reports when a release is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 86 |

## Fix

Change the release so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule network-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
