# Rule config-031

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 9 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule config-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
