# Rule targets-029

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `targets` |
| Severity | `warning` |
| Limit | 24 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule targets-029
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
