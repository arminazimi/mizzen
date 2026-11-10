# Rule artifacts-039

Reports when a target is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 60 |

## Fix

Change the target so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
