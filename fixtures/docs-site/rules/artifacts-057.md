# Rule artifacts-057

Reports when a target is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 65 |

## Fix

Change the target so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-057
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
