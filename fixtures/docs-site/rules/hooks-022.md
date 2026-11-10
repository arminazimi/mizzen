# Rule hooks-022

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 41 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-022
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
