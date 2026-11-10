# Rule secrets-037

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 46 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-037
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
