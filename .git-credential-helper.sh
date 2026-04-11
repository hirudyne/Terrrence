#!/bin/sh
# Reads GITHUB_PAT from /workspace/.secrets and emits git credentials.
. /workspace/.secrets
echo "username=hirudyne"
echo "password=$GITHUB_PAT"
