# Rule cache-013

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 22 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-013
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
