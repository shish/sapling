FROM ubuntu:20.04 AS base

# https://serverfault.com/a/1016972 to ensure installing tzdata does not
# result in a prompt that hangs forever.
ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Update and install some basic packages to register a PPA.
RUN apt-get -y update
RUN apt-get -y install ca-certificates curl git gnupg

# Use a PPA to ensure a specific version of Node (the default Node on
# Ubuntu 20.04 is v10, which is too old):
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_16.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

# Now we can install the bulk of the packages:
RUN apt-get -y update
RUN apt-get -y install nodejs pkg-config libssl-dev cython3 make g++ dpkg-dev python3.8 python3.8-dev python3.8-distutils

# Unfortunately, we cannot `apt install cargo` because at the time of this
# writing, it installs a version of cargo that is too old (1.59). Specifically,
# cargo <1.60 has a known issue with weak dependency features:
#
# https://github.com/rust-lang/cargo/issues/10623
#
# which is new Cargo syntax that was introduced in Rust 1.60:
#
# https://blog.rust-lang.org/2022/04/07/Rust-1.60.0.html
#
# and indeed one of our dependencies makes use of this feature:
# https://github.com/rust-phf/rust-phf/blob/250c6b456fe28c0c8213518d6bddfd972922fd53/phf/Cargo.toml#L22
#
# Realistically, the Rust ecosystem moves forward quickly, so installing via
# rustup is the most sustainable option.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN npm install --global yarn
RUN yarn config set yarn-offline-mirror "$HOME/npm-packages-offline-cache"


# Populate the Yarn offline mirror with the packages needed by the
# sapling-cli repo. Done in a separate stage so that the cache can be
# reused without needing the several GB of baggage that comes with it.
FROM base AS populate-offline-cache
# Copy the full repo over because `cargo fetch` follows deps within the repo,
# so assume it needs everything.
COPY . /tmp/repo
WORKDIR /tmp/repo

# Create and populate a Yarn offline mirror by running `yarn install`
# in the addons/ folder that contains yarn.lock, package.json, and the
# package.json file for each entry in the Yarn workspace.
# If the addons/ folder is moved or no longer contains a package.json,
# this command will fail and should be updated to reflect the new location.
RUN yarn --cwd addons install --prefer-offline

# Verify the yarn-offline-mirror was populated.
RUN find $(yarn config get yarn-offline-mirror)


# Use the base stage with the dev tools installed, and copy the offline
# package cache into it.
FROM base AS main
COPY --from=populate-offline-cache /root/npm-packages-offline-cache /root/npm-packages-offline-cache
