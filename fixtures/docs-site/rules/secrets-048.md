# Rule secrets-048

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 6 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
