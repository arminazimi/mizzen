# Rule config-009

Reports when a environment points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 57 |

## Fix

Change the environment so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
