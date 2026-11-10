# Rule config-022

Reports when a build step uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `config` |
| Severity | `info` |
| Limit | 15 |

## Fix

Change the build step so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule config-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
