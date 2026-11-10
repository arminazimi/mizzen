# Rule secrets-047

Reports when a hook is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 36 |

## Fix

Change the hook so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-047
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
