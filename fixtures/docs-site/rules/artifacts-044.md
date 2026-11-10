# Rule artifacts-044

Reports when a artifact uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 36 |

## Fix

Change the artifact so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-044
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
