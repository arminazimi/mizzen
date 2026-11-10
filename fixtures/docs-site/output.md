# Output format

Plain text is for people, `--json` is for machines.

## Text

One line per step, prefixed with the step name, and a final line with the URL. Warnings start with
`warn:` and errors with `error:`; the exit code is non-zero only for errors.

## JSON

`beacon deploy --json` prints one object per step with `step`, `status`, `seconds`, and `detail`.
The last object carries `url` and `artifact`. CI pipelines read it in
[CI integration](ci.md).
