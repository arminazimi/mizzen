# Rule config-028

Reports when a environment is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `error` |
| Limit | 30 |

## Fix

Change the environment so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule config-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
