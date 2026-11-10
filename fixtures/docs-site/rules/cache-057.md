# Rule cache-057

Reports when a target uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `error` |
| Limit | 79 |

## Fix

Change the target so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-057
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
