# Rule build-033

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 54 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-033
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
