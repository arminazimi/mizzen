# Rule artifacts-059

Reports when a target is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 6 |

## Fix

Change the target so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-059
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
