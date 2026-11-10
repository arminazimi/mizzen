# Rule network-040

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 39 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-040
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
