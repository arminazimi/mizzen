# Rule artifacts-014

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 38 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
