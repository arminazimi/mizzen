---
title: Deploy to GitLab Pages
description: Build a Slipway site with the engine and publish the output to GitLab Pages.
layout: doc
permalink: /recipes/gitlab-pages/
date: 2024-03-20
author: Slipway
---

## Deploy to GitLab Pages

GitLab Pages publishes the `public/` folder from a CI job. Build a Slipway site with the engine in that job; no Jekyll or Ruby is involved.

### Configure the site

Keep the engine and the theme in the site's `package.json`:

```sh
npm install --save-dev @velella/mizzen @velella/lateen
```

For a project page such as `https://username.gitlab.io/projectname`, set `url` and `base` in `mizzen.yml`; for a group or user page at the domain root, leave `base` empty:

```yaml
url: https://username.gitlab.io
base: /projectname
```

### Add the CI job

Create `.gitlab-ci.yml` at the repository root. The job builds into `public/`, which is the folder GitLab Pages publishes:

```yaml
pages:
  image: node:24
  script:
    - npm ci
    - npx mizzen build . --out public
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

Add `npx mizzen check .` before the build to fail the job on a diagnostic. GitLab runs the job on every push to the default branch and publishes the artifact.

For the Pages settings and the `public/` requirement, see the [GitLab Pages documentation](https://docs.gitlab.com/ee/user/project/pages/).
