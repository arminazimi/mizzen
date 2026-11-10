# Rule hooks-014

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 70 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-014
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
