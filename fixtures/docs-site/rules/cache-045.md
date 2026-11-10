# Rule cache-045

Reports when a build step uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 75 |

## Fix

Change the build step so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-045
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
