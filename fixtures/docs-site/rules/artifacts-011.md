# Rule artifacts-011

Reports when a environment is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 40 |

## Fix

Change the environment so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
