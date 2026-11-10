# Rule logs-034

Reports when a manifest uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `error` |
| Limit | 1 |

## Fix

Change the manifest so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-034
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
