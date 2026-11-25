import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'

const target = 'E:/selfwork/json-studio/node_modules/tesseract.js'
console.log('exists tesseract dir:', existsSync(target))
try {
  console.log('readdir:', readdirSync(target).slice(0, 5))
} catch (error) {
  console.log('readdir failed:', error.code, error.message)
}
const require = createRequire(import.meta.url)
try {
  console.log('require.resolve:', require.resolve('tesseract.js'))
} catch (error) {
  console.log('require.resolve failed:', error.code, error.message)
}
try {
  const pkg = await import('tesseract.js')
  console.log('import ok:', Object.keys(pkg).slice(0, 3))
} catch (error) {
  console.log('import failed:', error.code, error.message)
}
try {
  console.log('realpath:', (await import('node:fs')).realpathSync(target))
} catch (error) {
  console.log('realpath failed:', error.code)
}
