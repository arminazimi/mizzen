# Rule cache-048

Reports when a token uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 74 |

## Fix

Change the token so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-048
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
