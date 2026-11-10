# Rule hooks-056

Reports when a environment is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `warning` |
| Limit | 62 |

## Fix

Change the environment so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-056
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
