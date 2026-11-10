# Rule build-012

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `warning` |
| Limit | 60 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
