# Rule targets-035

Reports when a artifact is larger than the limit.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 73 |

## Fix

Change the artifact so it no longer is larger than the limit, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-035
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
