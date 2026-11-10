# Rule build-019

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 32 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule build-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
