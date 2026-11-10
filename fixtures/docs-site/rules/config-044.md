# Rule config-044

Reports when a token points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 8 |

## Fix

Change the token so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule config-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
