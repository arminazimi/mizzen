# Rule build-007

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `build` |
| Severity | `error` |
| Limit | 60 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule build-007
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
