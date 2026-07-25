# Release gates

## Before push

- Worktree scope is intentional.
- Commit message passes `cog verify`.
- Type-check, tests, inference corpus, example, runtime boundary, and relevant
  package/fault gates pass.
- Remote branch has not advanced unexpectedly.

## Release PR

- release-please selected the intended next version.
- Changelog contains only the intended commits.
- Package version and release metadata are coherent.
- Required upgrade guide exists for consumer action.

## Publish

The release workflow must:

- type-check and test;
- build JavaScript and declarations;
- run package entrypoint and engine smoke tests;
- validate tarball contents and version parity;
- publish through npm Trusted Publishing with provenance.

## External verification

- GitHub tag points to the intended release commit.
- GitHub Release exists for that tag.
- npm package version and `latest` dist-tag are correct.
- Registry integrity and provenance are present.
- npm `gitHead` matches the intended commit.
- Local branch, remote branch, and tag are synchronized.

If any gate is pending, report the exact pending state rather than “released.”
