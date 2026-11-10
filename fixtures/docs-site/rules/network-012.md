# Rule network-012

Reports when a release is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 70 |

## Fix

Change the release so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
