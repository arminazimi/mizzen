# Rule secrets-009

Reports when a target is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 12 |

## Fix

Change the target so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
