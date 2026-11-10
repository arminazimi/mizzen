# Rule secrets-018

Reports when a build step is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 8 |

## Fix

Change the build step so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
