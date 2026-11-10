# Rule secrets-010

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 23 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-010
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
