# Rule secrets-019

Reports when a token is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 41 |

## Fix

Change the token so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
