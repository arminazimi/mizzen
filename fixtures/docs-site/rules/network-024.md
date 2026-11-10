# Rule network-024

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 60 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule network-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
