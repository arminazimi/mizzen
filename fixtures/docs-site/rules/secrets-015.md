# Rule secrets-015

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 66 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-015
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
