# Rule deploy-055

Reports when a release uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `deploy` |
| Severity | `error` |
| Limit | 40 |

## Fix

Change the release so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule deploy-055
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
