# Rule artifacts-048

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `info` |
| Limit | 44 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
