# Rule secrets-036

Reports when a hook is missing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 70 |

## Fix

Change the hook so it no longer is missing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
