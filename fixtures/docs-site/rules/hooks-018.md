# Rule hooks-018

Reports when a artifact is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 48 |

## Fix

Change the artifact so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-018
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
