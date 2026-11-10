# Rule deploy-044

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 51 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
