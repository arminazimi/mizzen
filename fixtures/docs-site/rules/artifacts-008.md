# Rule artifacts-008

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 56 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-008
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
