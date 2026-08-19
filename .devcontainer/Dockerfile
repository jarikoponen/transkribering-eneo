FROM mcr.microsoft.com/devcontainers/python:1-3.12-bookworm

# The upstream image can contain a stale Yarn apt source. Dev Container features
# run apt-get update while installing tooling, so remove that source first.
RUN find /etc/apt/sources.list.d -type f -name '*yarn*' -delete \
    && if [ -f /etc/apt/sources.list ]; then sed -i '/dl.yarnpkg.com/d' /etc/apt/sources.list; fi
