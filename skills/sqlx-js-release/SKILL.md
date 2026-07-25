---
name: sqlx-js-release
description: Prepare, trigger, monitor, and verify an sqlx-js npm release through Conventional Commits, release-please, GitHub tags and releases, Trusted Publishing provenance, package smoke tests, and registry verification. Use only when a user explicitly asks to release, publish, tag, or carry a change through the release pipeline.
---

# sqlx-js release

Use the repository's automated release authority. Do not create manual version
or tag drift.

## Authorization boundary

Require explicit user authorization before commit, push, release PR merge,
manual workflow dispatch, or publication. Read-only inspection does not require
mutation authorization.

## Workflow

1. Inspect current branch, worktree, remote SHA, package version, tags, and
   active release PR/workflows.
2. Verify the intended changes and Conventional Commit impact.
3. Run the relevant local gates.
4. Push the intended branch only when authorized.
5. Let release-please create or update the release PR.
6. Review version and changelog metadata.
7. Merge the release PR only when authorized.
8. Monitor the tag, release, test/build/package gates, and npm publish.
9. Verify registry version, dist-tag, integrity, provenance, `gitHead`, tag, and
   local/remote alignment.

Read [the release gates](references/release-gates.md) before reporting closure.

## Version policy

Before 1.0, `feat` produces a minor release and `fix` a patch release.
Breaking changes also produce a minor release. Reaching `1.0.0` requires an
explicit `Release-As: 1.0.0` trailer.

## Closure rule

A commit or green local suite is not a release. A release is complete only
after the published npm artifact and GitHub/tag metadata are verified against
the expected commit.
