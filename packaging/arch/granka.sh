#!/bin/sh
# Wrapper: the app code lives in /usr/lib/granka, Electron comes from the system.
exec /usr/bin/electron /usr/lib/granka "$@"
