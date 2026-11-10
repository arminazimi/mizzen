# Rule logs-060

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 94 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-060
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
