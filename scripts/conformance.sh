#!/usr/bin/env bash
# Runs only the docuconf-go-facing checks against a given docuconf-go checkout:
# the shared conformance suite (@docuconf/core) and the export tests that
# `cue vet` exported contracts against the meta-schema (@docuconf/t3,
# @docuconf/nestjs). Not the full suite.
#
#   DOCUCONF_GO_DIR=/path/to/docuconf-go scripts/conformance.sh
#
# Needs node, npm and cue on PATH. docuconf-go's downstream workflow and this
# repository's CI both call it.
set -euo pipefail

: "${DOCUCONF_GO_DIR:?set DOCUCONF_GO_DIR to a docuconf-go checkout}"
DOCUCONF_GO_DIR="$(cd "$DOCUCONF_GO_DIR" && pwd)"
export DOCUCONF_GO_DIR
export DOCUCONF_CONFORMANCE="${DOCUCONF_CONFORMANCE:-$DOCUCONF_GO_DIR/conformance/cases.json}"
export DOCUCONF_SPEC_CUE="${DOCUCONF_SPEC_CUE:-$DOCUCONF_GO_DIR/spec/cue}"
export DOCUCONF_REQUIRE_CONFORMANCE=1
export DOCUCONF_REQUIRE_VET=1

cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npx vitest run \
  packages/core/test/conformance.test.ts \
  packages/t3/test/export.test.ts \
  packages/nestjs/test/export.test.ts
