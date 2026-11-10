# Rule logs-009

Reports when a artifact uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 34 |

## Fix

Change the artifact so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-009
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
