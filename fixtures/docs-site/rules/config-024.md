# Rule config-024

Reports when a hook is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 65 |

## Fix

Change the hook so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
