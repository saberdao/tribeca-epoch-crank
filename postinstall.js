const fs = require('fs')

// Fix an assert polyfill that is introduced by
// polyfilling webpack things needed by Solana

const f = fs.readFileSync('./node_modules/@saberhq/token-utils/package.json').toString()
fs.writeFileSync(
  './node_modules/@saberhq/token-utils/package.json',
  f.replace('"module"', '"commonjs"')
)

const g = fs.readFileSync('./node_modules/@ubeswap/token-math/package.json').toString()
fs.writeFileSync(
  './node_modules/@ubeswap/token-math/package.json',
  g.replace('"module"', '"commonjs"')
)
