# Rule logs-030

Reports when a artifact uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 35 |

## Fix

Change the artifact so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
