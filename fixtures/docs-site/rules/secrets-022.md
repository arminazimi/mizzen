# Rule secrets-022

Reports when a environment is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 40 |

## Fix

Change the environment so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
