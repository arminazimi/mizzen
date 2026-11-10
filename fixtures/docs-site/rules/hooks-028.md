# Rule hooks-028

Reports when a artifact is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 71 |

## Fix

Change the artifact so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-028
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
