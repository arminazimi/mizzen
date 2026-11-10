# Rule build-014

Reports when a build step is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `info` |
| Limit | 48 |

## Fix

Change the build step so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule build-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
