# Rule targets-024

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `error` |
| Limit | 63 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-024
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
