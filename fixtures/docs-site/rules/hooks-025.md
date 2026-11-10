# Rule hooks-025

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 20 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
