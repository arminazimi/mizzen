# Rule targets-038

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 8 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-038
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
