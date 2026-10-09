#!/usr/bin/env bash
# Runs only the docuconf-go-facing checks against a given docuconf-go checkout:
# the shared conformance suite (@docuconf/core, every case run, none
# skipped), the shared export fixture compared with conformance/export/golden.cue
# by `docuconf conformance export` (@docuconf/t3), and the export tests that
# `cue vet` exported contracts against the meta-schema (@docuconf/t3,
# @docuconf/nestjs). Not the full suite.
#
#   DOCUCONF_GO_DIR=/path/to/docuconf-go scripts/conformance.sh
#
# Needs node, npm and cue on PATH, and go to build the docuconf CLI from the
# checkout unless DOCUCONF_CLI names one. docuconf-go's downstream workflow and
# this repository's CI both call it.
set -euo pipefail

: "${DOCUCONF_GO_DIR:?set DOCUCONF_GO_DIR to a docuconf-go checkout}"
DOCUCONF_GO_DIR="$(cd "$DOCUCONF_GO_DIR" && pwd)"
export DOCUCONF_GO_DIR
export DOCUCONF_CONFORMANCE="${DOCUCONF_CONFORMANCE:-$DOCUCONF_GO_DIR/conformance/cases.json}"
export DOCUCONF_SPEC_CUE="${DOCUCONF_SPEC_CUE:-$DOCUCONF_GO_DIR/spec/cue}"
export DOCUCONF_EXPORT_GOLDEN="${DOCUCONF_EXPORT_GOLDEN:-$DOCUCONF_GO_DIR/conformance/export/golden.cue}"
export DOCUCONF_REQUIRE_CONFORMANCE=1
export DOCUCONF_REQUIRE_VET=1
if [ -z "${DOCUCONF_CLI:-}" ]; then
  DOCUCONF_CLI="$(mktemp -d)/docuconf"
  (cd "$DOCUCONF_GO_DIR/cmd/docuconf" && go build -o "$DOCUCONF_CLI" .)
fi
export DOCUCONF_CLI

cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npx vitest run \
  packages/core/test/conformance.test.ts \
  packages/t3/test/conformance-export.test.ts \
  packages/t3/test/export.test.ts \
  packages/nestjs/test/export.test.ts
