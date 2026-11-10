# Rule hooks-019

Reports when a release is empty.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `info` |
| Limit | 2 |

## Fix

Change the release so it no longer is empty, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-019
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
