# Rule build-025

Reports when a build step is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 40 |

## Fix

Change the build step so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule build-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
