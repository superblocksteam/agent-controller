#!/bin/bash

set -e

if [[ -z ${SUPERBLOCKS_AGENT_INTERNAL_HOST} ]] && [[ "$SUPERBLOCKS_AGENT_INTERNAL_HOST_AUTO" == "true" ]]; then
  export SUPERBLOCKS_AGENT_INTERNAL_HOST=$(hostname -i)
fi

# We can add platform specific stuff to this file as well.

exec "$@"
