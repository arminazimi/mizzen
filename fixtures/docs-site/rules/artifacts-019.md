# Rule artifacts-019

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `artifacts` |
| Severity | `error` |
| Limit | 9 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule artifacts-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
