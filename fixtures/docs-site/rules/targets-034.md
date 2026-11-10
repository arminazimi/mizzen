# Rule targets-034

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 30 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
