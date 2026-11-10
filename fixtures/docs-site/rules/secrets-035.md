# Rule secrets-035

Reports when a build step is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 19 |

## Fix

Change the build step so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
