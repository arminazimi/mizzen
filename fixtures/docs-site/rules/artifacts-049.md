# Rule artifacts-049

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 78 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-049
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
