# Rule artifacts-042

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 61 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-042
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
