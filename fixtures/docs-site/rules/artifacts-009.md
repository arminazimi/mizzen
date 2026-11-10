# Rule artifacts-009

Reports when a environment is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 63 |

## Fix

Change the environment so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
