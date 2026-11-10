#!/bin/sh
# Pack the SDK, install the tarball into clean projects and check what a consumer sees:
#   1. import the tarball (ESM)           2. tsc with skipLibCheck:false       3. `next build` (app router, client component)
# Run after `pnpm build`. Needs network (npm install). Usage: sh test/fixtures/consumers.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
sdk="$here/../.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$sdk" && npm pack --pack-destination "$tmp" >/dev/null)
tgz="$(ls "$tmp"/*.tgz)"

mkdir "$tmp/import" && cd "$tmp/import"
echo '{"name":"wt-import","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund "$tgz"
node -e "import('@watchtowerobservability/browser').then((m) => { if (typeof m.init !== 'function') throw new Error('init missing'); console.log('import ok'); })"

mkdir "$tmp/types" && cd "$tmp/types"
cp "$here/types/"* .
echo '{"name":"wt-types","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund "$tgz" typescript@5
npx tsc -p tsconfig.json
echo "types ok (skipLibCheck:false)"

cp -R "$here/next-app" "$tmp/next-app" && cd "$tmp/next-app"
npm install --no-audit --no-fund "$tgz" next@15 react@19 react-dom@19 typescript@5 @types/react@19 @types/react-dom@19 @types/node@22
npx next build
echo "next build ok"
