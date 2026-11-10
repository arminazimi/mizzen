# Rule hooks-012

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 77 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-012
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
