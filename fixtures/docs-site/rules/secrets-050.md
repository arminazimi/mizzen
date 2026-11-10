# Rule secrets-050

Reports when a build step is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 18 |

## Fix

Change the build step so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
