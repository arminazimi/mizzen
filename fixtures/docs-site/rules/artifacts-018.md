# Rule artifacts-018

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 15 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
