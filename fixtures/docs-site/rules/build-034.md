# Rule build-034

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 85 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule build-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
