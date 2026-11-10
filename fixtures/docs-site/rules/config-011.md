# Rule config-011

Reports when a hook is not readable.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 22 |

## Fix

Change the hook so it no longer is not readable, then run `beacon doctor` again.

```bash
beacon doctor --rule config-011
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
