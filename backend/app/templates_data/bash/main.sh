#!/bin/bash
echo "Hello from Bash $BASH_VERSION"
for i in 1 2 3; do
  echo "count: $i"
done
echo "You are $(whoami) in $(pwd)"
