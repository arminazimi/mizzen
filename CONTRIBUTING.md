# Contributing to Mizzen

Thank you for helping. Most contributions are a bug report, a fix, a docs improvement, or a new test.

## Set up

Mizzen needs Node 24 or later, which runs the TypeScript source directly: there is no build step.

```bash
git clone https://github.com/velella-sh/lateen.git
git clone https://github.com/velella-sh/mizzen.git
cd mizzen
npm ci
(cd ../lateen && npm ci)
```

Lateen is checked out beside this repository because the tests and the docs site build with both.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

A change to behavior needs a test beside the others in `test/`. A change to the docs site is checked with `node bin/mizzen.ts check site` and must report 0 errors.

## Ground rules

- Use only erasable TypeScript syntax (no `enum`, `namespace`, or parameter properties) and import local files with their `.ts` extension.
- Never commit compiled output.
- Keep a pull request to one change, and describe what it fixes and how you checked it.
- Security problems go through the organization's security policy, not a public issue.
