# Rule network-025

Reports when a token is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 1 |

## Fix

Change the token so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
