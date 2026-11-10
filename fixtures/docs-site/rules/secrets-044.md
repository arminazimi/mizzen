# Rule secrets-044

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 26 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
