# Rule logs-018

Reports when a release is older than expected.

## Details

| Property | Value |
| --- | --- |
| Category | `logs` |
| Severity | `warning` |
| Limit | 47 |

## Fix

Change the release so it no longer is older than expected, then run `beacon doctor` again.

```bash
beacon doctor --rule logs-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
