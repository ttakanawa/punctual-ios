#!/bin/bash
set -euo pipefail

swift format lint --configuration .swift-format --recursive --strict "$@"
"${SWIFTLINT_BIN:-swiftlint}" lint --config .swiftlint.yml --strict --no-cache "$@"
