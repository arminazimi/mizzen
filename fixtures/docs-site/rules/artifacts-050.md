# Rule artifacts-050

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `warning` |
| Limit | 40 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-050
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
