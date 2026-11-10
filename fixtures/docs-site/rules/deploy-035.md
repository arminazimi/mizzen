# Rule deploy-035

Reports when a environment uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 99 |

## Fix

Change the environment so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
