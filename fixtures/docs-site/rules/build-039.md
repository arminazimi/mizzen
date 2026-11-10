# Rule build-039

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 29 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule build-039
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
