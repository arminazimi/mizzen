# Rule deploy-036

Reports when a environment is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `warning` |
| Limit | 55 |

## Fix

Change the environment so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-036
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
