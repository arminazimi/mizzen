# Rule network-045

Reports when a environment is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 16 |

## Fix

Change the environment so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
