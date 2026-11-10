# Rule secrets-043

Reports when a build step points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 61 |

## Fix

Change the build step so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-043
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
