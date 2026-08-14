#!/usr/bin/env bash
# sample.sh - synthetic shell script for Explorer preview testing
set -euo pipefail

echo "Explorer shell-script preview sample"

items=(Apple Banana Grape)
for i in "${!items[@]}"; do
  echo "$((i + 1)). ${items[$i]}"
done
