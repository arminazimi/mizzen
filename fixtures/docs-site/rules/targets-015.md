# Rule targets-015

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 48 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
