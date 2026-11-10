# Rule secrets-045

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `info` |
| Limit | 49 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
