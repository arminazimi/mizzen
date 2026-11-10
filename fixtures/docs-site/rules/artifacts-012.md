# Rule artifacts-012

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 81 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
