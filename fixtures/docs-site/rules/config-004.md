# Rule config-004

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `warning` |
| Limit | 18 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-004
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
