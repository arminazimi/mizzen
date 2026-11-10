# Rule secrets-025

Reports when a build step uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 9 |

## Fix

Change the build step so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-025
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
