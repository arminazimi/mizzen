# Rule build-021

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 6 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-021
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
