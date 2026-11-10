# Rule secrets-031

Reports when a token is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 95 |

## Fix

Change the token so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-031
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
